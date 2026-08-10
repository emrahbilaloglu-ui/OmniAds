import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bindD061ReplayProfileContextToCalibrationAdmission,
  buildD061AuthorityArtifactPlan,
  canonicalRestatedCalibrationFact,
  compactArtifactRepositoryContentParity,
  deduplicateD061RestatedFacts,
  d061NativeReplayProfileScope,
  d061ReplayStabilityKey,
  parseD061ClosedWindowReplayArgs,
  pinD061ReplayProfileToPhysicalAccount,
  restateSourceAvailabilityAtCutoff,
  selectHistoricalTargetAtCutoff,
  selectSemanticRestatedTargetAtCutoff,
  verifyAuthorityArtifactChecksumSidecar,
  verifyCompactAuthorityArtifactFile,
} from "@/scripts/creative-decision-center/native-ad-account-aov-closed-window-replay";
import {
  adDecisionStabilityKey,
  applyLabelHysteresis,
} from "@/lib/creative-decision-engine/decision-stability";
import { canonicalSha256 } from "@/lib/creative-decision-engine/canonical-evaluation";
import { NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION } from "@/lib/creative-decision-engine/jobs/ad-operator-response-job";
import type {
  NativeAdCalibrationSourceRow,
  NativeAdTargetAuthorityInput,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import { META_CANONICAL_METRIC_SCHEMA_VERSION } from "@/lib/meta/canonical-metrics";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  buildRepositoryContentManifest,
  readReplayCodeProvenance as readAuthorityReplayCodeProvenance,
} from "@/scripts/creative-decision-center/native-ad-account-aov-authority-replay";

const AUTHORITY_AS_OF_ARG = "--authority-as-of=2026-07-19";

function target(input: {
  id: string;
  effectiveAt: string;
  recordedAt?: string;
  operation?: "upsert" | "delete";
}) {
  return {
    businessId: "business-a",
    sourceRowId: input.id,
    operation: input.operation ?? "upsert",
    targetCpa: null,
    targetRoas: 2,
    breakEvenCpa: null,
    breakEvenRoas: 1.2,
    operatorAovAssumption: null,
    defaultRiskPosture: "balanced",
    effectiveAt: input.effectiveAt,
    recordedAt: input.recordedAt ?? input.effectiveAt,
  } satisfies NativeAdTargetAuthorityInput & { businessId: string };
}

function sourceRow(): NativeAdCalibrationSourceRow {
  return {
    sourceRowId: "source-a",
    businessId: "business-a",
    providerAccountRefId: "00000000-0000-4000-8000-000000000001",
    providerAccountId: "act_a",
    date: "2026-06-01",
    campaignId: "campaign-a",
    adsetId: "adset-a",
    adId: "ad-a",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    sourceAccountTimezone: "UTC",
    sourceAccountCurrency: "USD",
    metricSchemaVersion: META_CANONICAL_METRIC_SCHEMA_VERSION,
    objective: "OUTCOME_SALES",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    customEventType: "PURCHASE",
    spend: 100,
    impressions: 1_000,
    clicks: 100,
    linkClicks: 80,
    conversions: 1,
    revenue: 200,
    truthState: "FINALIZED",
    validationStatus: "PASSED",
    finalizedAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-06-01T01:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    campaignSourceRowId: "campaign-row-a",
    campaignTruthState: "FINALIZED",
    campaignValidationStatus: "PASSED",
    campaignCreatedAt: "2026-06-01T01:00:00.000Z",
    campaignUpdatedAt: "2026-07-01T00:00:00.000Z",
    adsetSourceRowId: "adset-row-a",
    adsetTruthState: "FINALIZED",
    adsetValidationStatus: "PASSED",
    adsetCreatedAt: "2026-06-01T01:00:00.000Z",
    adsetUpdatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function validSchedulerPopulationCompactArtifact() {
  const rowManifestHash = "b".repeat(64);
  const expectedBusinesses = [
    {
      schedulerPosition: 1,
      businessId: "business-a",
      businessName: "Business A",
    },
  ];
  const expectedProviderAccounts = [
    {
      businessId: "business-a",
      providerAccountRefId: "provider-ref-a",
      providerAccountId: "act_a",
    },
  ];
  const envDefaultEnabled = true;
  const manifestHash = canonicalSha256({
    envDefaultEnabled,
    businesses: expectedBusinesses,
    providerAccounts: expectedProviderAccounts,
  });
  return {
    contractVersion:
      "adsecute.meta.native-ad-account-aov-current-day-production-parity.v7",
    generatedAt: "2026-07-19T03:15:00.000Z",
    parameters: {
      asOfDate: "2026-07-19",
      businessFilter: [],
      providerAccountFilter: [],
      baselineEngineVersion: NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION,
      challengerEngineVersion: NATIVE_AD_ENGINE_VERSION,
    },
    safety: {
      databaseAccess: "existing_local_ssh_tunnel_only",
      transaction: {
        transactionReadOnly: "on",
        defaultTransactionReadOnly: "on",
        transactionIsolation: "repeatable read",
        statementTimeout: "30000ms",
        applicationName: "adsecute-test",
      },
      providerWrites: false,
      databaseWrites: false,
      manualCron: false,
    },
    coverage: {
      businesses: 1,
      accounts: 1,
      accountCutoffSlices: 1,
      preparedAccountCutoffSlices: 1,
      failedAccountCutoffSlices: 0,
      baselineRows: 1,
      challengerComputedRows: 1,
      challengerFailedRows: 0,
    },
    mediaBuyerRowAudit: {
      rowCount: 1,
      rowsOmitted: true,
    },
    artifactProjection: {
      contractVersion:
        "adsecute.meta.native-ad-account-aov-replay-compact-proof.v7",
      projectionMode:
        "full_release_proof_with_media_buyer_rows_omitted_and_hash_bound",
      fullArtifactSha256: "d".repeat(64),
      fullArtifactBytes: 1,
      omittedMediaBuyerRowCount: 1,
      omittedMediaBuyerRowsCanonicalSha256: "e".repeat(64),
      cohortKeyHashSetSha256: "f".repeat(64),
      identityHashSetSha256: "1".repeat(64),
      calibrationContextProofSetCommitment: {
        contractVersion: "native-ad-replay-calibration-context-proof-set.v1",
        proofContractVersion:
          "native-ad-replay-calibration-context-proof.v1",
        contextCount: 1,
        associationCount: 1,
        proofSetHash: "c".repeat(64),
        fullMaterialOmitted: true,
      },
      schedulerPopulationManifestHash: manifestHash,
      schedulerPopulationExpectedBusinessCount: 1,
      schedulerPopulationExpectedProviderAccountCount: 1,
      schedulerPopulationContradictions: 0,
      fullRowsRequiredForDrilldown: true,
    },
    releaseGate: {
      passed: true,
      exitCode: 0,
      checks: {
        executionFailures: 0,
        schedulerPopulationContradictions: 0,
        authorityProofOrLineageContradictions: 0,
        canonicalEnvelopeContradictions: 0,
        currentDayRestatementContradictions: 0,
        unresolvedSourceDimensionContradictions: 0,
        profileCalibrationParityContradictions: 0,
        requestedScopeCoverageContradictions: 0,
        aboveBreakEvenCutProjectionViolations: 0,
        aboveBreakEvenProjectionDriftRows: 0,
        scaleRefreshIdentityDriftRows: 0,
        calibrationCutoffFallbackSlices: 0,
        waveOrHydrationCoverageContradictions: 0,
        aovPositiveControlFailures: 0,
        d036PerRowTransitionViolations: 0,
        d063LegacySafeZoneProjectionDriftRows: 0,
        d063ExpandedStripSemanticViolationRows: 0,
        d063ExpandedHeldAuthorizedCutRows: 0,
        d063ExpandedHeldPendingRows: 0,
        d063AccountAovP25NullReachabilityFailures: 0,
        d063AccountAovP25BackedOverlayRows: 0,
        d063ExactMediaBuyerContradictions: 0,
      },
      failures: [],
    },
    failures: [],
    slicePreparationFailures: [],
    schedulerPopulationCoverage: {
      required: true,
      mode: "unfiltered_scheduler_population",
      schedulerContract: {
        activeBusinessLimit: 500,
        excludesDemoBusinesses: true,
        businessOrder: "created_at_asc",
        enabledSource: "business_override_then_current_env_default",
        metaEligibilitySource: "business_provider_accounts",
      },
      readWithinReplayRepeatableReadTransaction: true,
      envDefaultEnabled,
      expectedBusinessCount: 1,
      expectedProviderAccountCount: 1,
      observedAnchorCount: 1,
      observedIdentityAccountCount: 1,
      manifestHash,
      expectedBusinesses,
      expectedProviderAccounts,
      missingBusinessAnchors: [],
      unexpectedBusinessAnchors: [],
      duplicateBusinessAnchors: [],
      missingProviderAccountIdentities: [],
      unexpectedProviderAccountIdentities: [],
      anchorBusinessesWithoutIdentities: [],
      contradictions: 0,
    },
    waveCoverageProof: {
      businesses: [
        {
          businessId: "business-a",
          businessName: "Business A",
          decisionJobRunId: "decision-job-a",
          calibrationJobRunId: "calibration-job-a",
          expectedDecisionRows: 1,
          anchoredSnapshotRows: 1,
          selectedScopeSnapshotRows: 1,
          selectedFrozenSnapshotRows: 1,
          calibrationJobRowCount: 1,
          calibrationJobExpectedCellCount: 1,
          calibrationJobRowsWritten: 1,
          calibrationJobProviderAccountCount: 1,
          calibrationWaveReceiptCount: 1,
          calibrationWaveBatchCount: 1,
          calibrationWaveExpectedCellCount: 1,
          calibrationWaveActualCellCount: 1,
          calibrationWaveReceiptContradictions: 0,
          valid: true,
        },
      ],
      accounts: [
        {
          businessId: "business-a",
          businessName: "Business A",
          providerAccountRefId: "provider-ref-a",
          providerAccountId: "act_a",
          anchoredAccountTimezone: "UTC",
          anchoredAccountCurrency: "USD",
          calibrationBatchId: "calibration-batch-a",
          calibrationBatchJobRunId: "calibration-job-a",
          calibrationReceiptCount: 1,
          hydrationReceiptCount: 1,
          calibrationBatchExpectedCellCount: 1,
          calibrationBatchActualCellCount: 1,
          frozenRows: 1,
          receiptExpectedRows: 1,
          receiptHydratedRows: 1,
          recomputedManifestHash: rowManifestHash,
          receiptExpectedManifestHash: rowManifestHash,
          receiptHydratedManifestHash: rowManifestHash,
          calibrationReceiptExact: true,
          profileCalibrationExact: true,
          canonicalEnvelopeExact: true,
          authoritativeForPrune: true,
          calibrationLineageValid: true,
          valid: true,
        },
      ],
      contradictions: 0,
    },
    exactMediaBuyerAudit: {
      required: true,
      declaredScopeComplete: true,
      contradictions: 0,
      violations: [],
    },
  };
}

describe("D061 closed-window replay producer", () => {
  it("uses the physical Meta account scope for chronological D036 memory", () => {
    const identity = {
      businessId: "11111111-1111-4111-8111-111111111111",
      providerAccountRefId: "22222222-2222-4222-8222-222222222222",
      providerAccountId: "act_123",
      decisionEntityId: "ad-456",
    };
    const scope = d061NativeReplayProfileScope(identity.providerAccountId);
    const replayKey = d061ReplayStabilityKey({
      ...identity,
      scope,
    });

    expect(replayKey).toBe(
      adDecisionStabilityKey({
        ...identity,
        decisionEntityType: "ad",
        scopeType: "account",
        scopeId: "act_123",
      }),
    );
    expect(scope).toEqual({ type: "account", id: "act_123" });
    expect(() => d061NativeReplayProfileScope("  ")).toThrow(
      "physical provider account id",
    );
  });

  it("keeps ready and soft replay days on the same physical-account memory key", () => {
    const identity = {
      businessId: "11111111-1111-4111-8111-111111111111",
      providerAccountRefId: "22222222-2222-4222-8222-222222222222",
      providerAccountId: "act_123",
      decisionEntityId: "ad-456",
    };
    const retainedWildcardProfile = {
      scope: { type: "account", id: "*" },
      profileType: "retained",
    } as const;
    const readyProfile = pinD061ReplayProfileToPhysicalAccount(
      retainedWildcardProfile,
      identity.providerAccountId,
    );
    const softScope = d061NativeReplayProfileScope(identity.providerAccountId);

    expect(readyProfile).not.toBe(retainedWildcardProfile);
    expect(retainedWildcardProfile.scope.id).toBe("*");
    expect(readyProfile.scope).toEqual(softScope);
    expect(
      d061ReplayStabilityKey({ ...identity, scope: readyProfile.scope }),
    ).toBe(d061ReplayStabilityKey({ ...identity, scope: softScope }));
  });

  it("uses only the latest bitemporal target visible at the producer cutoff", () => {
    const old = target({
      id: "old",
      effectiveAt: "2026-04-01T00:00:00.000Z",
    });
    const later = target({
      id: "later",
      effectiveAt: "2026-06-01T02:00:00.000Z",
      recordedAt: "2026-06-01T04:00:00.000Z",
    });

    expect(
      selectHistoricalTargetAtCutoff([old, later], "2026-06-01T03:00:00.000Z"),
    ).toEqual(old);
    expect(
      selectHistoricalTargetAtCutoff(
        [old, { ...later, recordedAt: "2026-06-01T02:30:00.000Z" }],
        "2026-06-01T03:00:00.000Z",
      )?.sourceRowId,
    ).toBe("later");
  });

  it("keeps an old valid target authoritative and honors a later delete", () => {
    const old = target({
      id: "old",
      effectiveAt: "2026-01-01T00:00:00.000Z",
    });
    const deleted = target({
      id: "delete",
      effectiveAt: "2026-05-01T00:00:00.000Z",
      operation: "delete",
    });

    expect(
      selectHistoricalTargetAtCutoff([old], "2026-07-15T03:00:00.000Z"),
    ).toEqual(old);
    expect(
      selectHistoricalTargetAtCutoff(
        [old, deleted],
        "2026-07-15T03:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("selects a recorded-after target only for explicit semantic restatement", () => {
    const lateRecorded = target({
      id: "late-recorded",
      effectiveAt: "2026-04-01T00:00:00.000Z",
      recordedAt: "2026-07-14T12:00:00.000Z",
    });
    const cutoff = "2026-06-01T03:00:00.000Z";

    expect(selectHistoricalTargetAtCutoff([lateRecorded], cutoff)).toBeNull();
    expect(
      selectSemanticRestatedTargetAtCutoff([lateRecorded], cutoff),
    ).toEqual(lateRecorded);
    expect(
      selectSemanticRestatedTargetAtCutoff([lateRecorded], cutoff)?.recordedAt,
    ).toBe("2026-07-14T12:00:00.000Z");
  });

  it("restates finalized daily metric and hierarchy availability for the review-only lane", () => {
    const projected = restateSourceAvailabilityAtCutoff(
      sourceRow(),
      "2026-06-01T03:00:00.000Z",
    );

    expect(projected.createdAt).toBe("2026-06-01T01:00:00.000Z");
    expect(projected.updatedAt).toBe("2026-06-01T03:00:00.000Z");
    expect(projected.finalizedAt).toBe("2026-06-01T03:00:00.000Z");
    expect(projected.campaignUpdatedAt).toBe("2026-06-01T03:00:00.000Z");
    expect(projected.adsetUpdatedAt).toBe("2026-06-01T03:00:00.000Z");
    expect(
      restateSourceAvailabilityAtCutoff(
        { ...sourceRow(), finalizedAt: null },
        "2026-06-01T03:00:00.000Z",
      ).finalizedAt,
    ).toBeNull();
  });

  it("retains legacy null-finalized peer truth without admitting it to strict AOV truth", () => {
    expect(
      canonicalRestatedCalibrationFact({
        ...sourceRow(),
        finalizedAt: null,
      }),
    ).toBe(true);
    expect(
      canonicalRestatedCalibrationFact({
        ...sourceRow(),
        finalizedAt: null,
        campaignSourceRowId: null,
      }),
    ).toBe(false);
  });

  it("projects both persisted source account dimensions into replay calibration", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "scripts/creative-decision-center/native-ad-account-aov-closed-window-replay.ts",
      ),
      "utf8",
    );

    expect(source).toContain(
      "NULLIF(BTRIM(ad.account_timezone), '') AS source_account_timezone",
    );
    expect(source).toContain(
      "NULLIF(BTRIM(ad.account_currency), '') AS source_account_currency",
    );
  });

  it.each([
    [
      "account currency",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        accountCurrency: "EUR",
      }),
    ],
    [
      "account timezone",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        accountTimezone: "America/Chicago",
      }),
    ],
    [
      "source account currency",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        sourceAccountCurrency: "EUR",
      }),
    ],
    [
      "source account timezone",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        sourceAccountTimezone: "America/Chicago",
      }),
    ],
    [
      "metric schema",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        metricSchemaVersion: META_CANONICAL_METRIC_SCHEMA_VERSION + 1,
      }),
    ],
    [
      "campaign identity",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        campaignId: "campaign-b",
      }),
    ],
    [
      "ad-set identity",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        adsetId: "adset-b",
      }),
    ],
    [
      "objective",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        objective: "OUTCOME_LEADS",
      }),
    ],
    [
      "optimization goal",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        optimizationGoal: "LINK_CLICKS",
      }),
    ],
    [
      "custom event",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        customEventType: "LEAD",
      }),
    ],
    [
      "required metric",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        spend: row.spend + 1,
      }),
    ],
    [
      "optional metric",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        landingPageViews: 40,
      }),
    ],
  ])(
    "fails closed when duplicate facts disagree on %s authority",
    (_label, mutate) => {
      const first = sourceRow();
      const conflicting = {
        ...mutate(first),
        sourceRowId: "source-b",
      };

      expect(
        deduplicateD061RestatedFacts([first, conflicting]),
      ).toMatchObject({
        facts: [],
        conflictingDuplicateGroups: 1,
      });
    },
  );

  it("canonicalizes authoritative values and ignores duplicate selectors and cosmetic overlays", () => {
    const first = sourceRow();
    const equivalent = {
      ...first,
      sourceRowId: " source-0 ",
      businessId: " business-a ",
      providerAccountRefId:
        " 00000000-0000-4000-8000-000000000001 ",
      providerAccountId: " act_a ",
      date: "2026-06-01T23:59:59.000Z",
      campaignId: " campaign-a ",
      adsetId: " adset-a ",
      adId: " ad-a ",
      accountTimezone: " UTC ",
      accountCurrency: " usd ",
      sourceAccountTimezone: " UTC ",
      sourceAccountCurrency: " usd ",
      objective: " outcome-sales ",
      optimizationGoal: "offsite conversions",
      customEventType: "purchase",
      truthState: " finalized ",
      validationStatus: " passed ",
      finalizedAt: "2026-06-30T19:00:00-05:00",
      createdAt: "2026-05-31T20:00:00-05:00",
      updatedAt: "2026-06-30T19:00:00-05:00",
      campaignSourceRowId: " campaign-row-a ",
      campaignTruthState: "finalized",
      campaignValidationStatus: "passed",
      campaignCreatedAt: "2026-05-31T20:00:00-05:00",
      campaignUpdatedAt: "2026-06-30T19:00:00-05:00",
      adsetSourceRowId: " adset-row-a ",
      adsetTruthState: "finalized",
      adsetValidationStatus: "passed",
      adsetCreatedAt: "2026-05-31T20:00:00-05:00",
      adsetUpdatedAt: "2026-06-30T19:00:00-05:00",
      creativeId: "cosmetic-creative-b",
      stateOverlay: { status: "cosmetic" },
      lifecycleOverlay: { stage: "cosmetic" },
    } satisfies NativeAdCalibrationSourceRow;

    const deduplicated = deduplicateD061RestatedFacts([equivalent, first]);

    expect(deduplicated.conflictingDuplicateGroups).toBe(0);
    expect(deduplicated.facts).toHaveLength(1);
    expect(deduplicated.facts[0]).toMatchObject({
      sourceRowId: "source-0",
      businessId: "business-a",
      providerAccountRefId: "00000000-0000-4000-8000-000000000001",
      providerAccountId: "act_a",
      date: "2026-06-01",
      accountTimezone: "UTC",
      accountCurrency: "USD",
      sourceAccountTimezone: "UTC",
      sourceAccountCurrency: "USD",
      objective: "OUTCOME_SALES",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      customEventType: "PURCHASE",
      truthState: "FINALIZED",
      validationStatus: "PASSED",
      finalizedAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("binds replay profile requests to the production calibration account identity", () => {
    const candidate = {
      accountTimezone: "UTC",
      accountCurrency: "USD",
      preserved: "candidate",
    };
    const sourceProvenance = {
      timezoneAdmission: {
        status: "ready",
        accountTimezone: "America/Chicago",
      },
      currencyAdmission: {
        status: "ready",
        accountCurrency: "USD",
      },
    } as never;

    expect(
      bindD061ReplayProfileContextToCalibrationAdmission(candidate, {
        sourceProvenance,
      }),
    ).toEqual({
      accountTimezone: "America/Chicago",
      accountCurrency: "USD",
      preserved: "candidate",
    });
  });

  it("does not bind a blocked calibration account admission", () => {
    const candidate = {
      accountTimezone: "UTC",
      accountCurrency: "USD",
    };
    const sourceProvenance = {
      timezoneAdmission: {
        status: "blocked",
        accountTimezone: null,
      },
      currencyAdmission: {
        status: "blocked",
        accountCurrency: null,
      },
    } as never;

    expect(
      bindD061ReplayProfileContextToCalibrationAdmission(candidate, {
        sourceProvenance,
      }),
    ).toBe(candidate);
  });

  it("requires a ceiling that closes every 14-day decision window", () => {
    expect(() =>
      parseD061ClosedWindowReplayArgs([
        AUTHORITY_AS_OF_ARG,
        "--end=2026-06-27",
        "--outcome-ceiling=2026-07-10",
      ]),
    ).toThrow("close the 14-day window");
    expect(
      parseD061ClosedWindowReplayArgs([
        AUTHORITY_AS_OF_ARG,
        "--end=2026-06-27",
        "--outcome-ceiling=2026-07-11",
      ]),
    ).toMatchObject({
      decisionEndDate: "2026-06-27",
      outcomeCeiling: "2026-07-11",
      authorityAsOfDate: "2026-07-19",
      writeFiles: false,
    });
  });

  it("requires an explicit authority date, then defaults to no-write /tmp outputs and requires explicit file-write opt-in", () => {
    expect(() => parseD061ClosedWindowReplayArgs([])).toThrow(
      "--authority-as-of=YYYY-MM-DD is required",
    );
    expect(() =>
      parseD061ClosedWindowReplayArgs([
        "--authority-as-of=2026-02-30",
      ]),
    ).toThrow("--authority-as-of is invalid");
    expect(() =>
      parseD061ClosedWindowReplayArgs([
        AUTHORITY_AS_OF_ARG,
        AUTHORITY_AS_OF_ARG,
      ]),
    ).toThrow("--authority-as-of must be provided exactly once");
    expect(() =>
      parseD061ClosedWindowReplayArgs([
        AUTHORITY_AS_OF_ARG,
        "--authority-as-of=2026-07-20",
      ]),
    ).toThrow("--authority-as-of must be provided exactly once");

    const safeDefaults = parseD061ClosedWindowReplayArgs([
      AUTHORITY_AS_OF_ARG,
    ]);
    expect(safeDefaults).toMatchObject({
      authorityAsOfDate: "2026-07-19",
      jsonOut:
        "/tmp/native-ad-account-aov-closed-window-replay-2026-07-19.json",
      mdOut:
        "/tmp/native-ad-account-aov-closed-window-replay-2026-07-19.md",
      writeFiles: false,
    });
    expect(
      parseD061ClosedWindowReplayArgs([
        AUTHORITY_AS_OF_ARG,
        "--write-files",
      ]).writeFiles,
    ).toBe(true);
  });

  it("accepts a data-driven expected-account manifest without source literals", () => {
    expect(
      parseD061ClosedWindowReplayArgs([
        AUTHORITY_AS_OF_ARG,
        "--account=Primary account:act_synthetic_primary",
        "--account=Second account:act_synthetic_second",
      ]).accounts,
    ).toEqual([
      expect.objectContaining({
        label: "Primary account",
        providerAccountId: "act_synthetic_primary",
      }),
      expect.objectContaining({
        label: "Second account",
        providerAccountId: "act_synthetic_second",
      }),
    ]);
  });

  it("derives one same-date authority pair while retaining known non-evidence exclusions", () => {
    const plan = buildD061AuthorityArtifactPlan("2026-07-20");

    expect(plan).toMatchObject({
      authorityAsOfDate: "2026-07-20",
      focusedArtifactPath:
        "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-20-compact.json",
      focusedSidecarPath:
        "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-20-compact.sha256",
      populationArtifactPath:
        "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-20-all-current-population-compact.json",
      populationSidecarPath:
        "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-20-all-current-population-compact.sha256",
    });
    expect(plan.requiredRepositoryExclusions).toEqual(
      expect.arrayContaining([
        plan.focusedArtifactPath,
        plan.focusedSidecarPath,
        `${plan.focusedArtifactPath}.tmp`,
        plan.populationArtifactPath,
        plan.populationSidecarPath,
        `${plan.populationArtifactPath}.tmp`,
        "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-16-compact.json",
        "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-compact.json",
        "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-all-current-population-compact.json",
      ]),
    );
    for (const historicalArtifactPath of [
      "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-16-compact.json",
      "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-compact.json",
      "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-all-current-population-compact.json",
    ]) {
      expect(plan.requiredRepositoryExclusions).toEqual(
        expect.arrayContaining([
          historicalArtifactPath,
          historicalArtifactPath.replace(/\.json$/, ".sha256"),
          `${historicalArtifactPath}.tmp`,
        ]),
      );
    }
    expect(plan.requiredRepositoryExclusions).toHaveLength(15);
    expect(new Set(plan.requiredRepositoryExclusions).size).toBe(
      plan.requiredRepositoryExclusions.length,
    );
    expect(plan.requiredRepositoryExclusions).toEqual(
      [...plan.requiredRepositoryExclusions].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
  });

  it("fails closed when the focused authority checksum sidecar is absent, malformed, mismatched, or names another file", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "adsecute-authority-sidecar-"));
    const artifactRepositoryPath =
      "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-compact.json";
    const sidecarRepositoryPath = artifactRepositoryPath.replace(
      /\.json$/,
      ".sha256",
    );
    const artifactPath = join(repoRoot, artifactRepositoryPath);
    const sidecarPath = join(repoRoot, sidecarRepositoryPath);
    const artifactContent = '{"releaseGate":{"passed":true}}\n';
    const artifactSha256 = createHash("sha256")
      .update(artifactContent)
      .digest("hex");
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, artifactContent, "utf8");

    try {
      expect(
        verifyAuthorityArtifactChecksumSidecar({
          repoRoot,
          artifactRepositoryPath,
        }),
      ).toMatchObject({
        valid: false,
        actualSha256: artifactSha256,
        failures: ["authority_checksum_sidecar_missing"],
      });

      writeFileSync(sidecarPath, "not-a-checksum\n", "utf8");
      expect(
        verifyAuthorityArtifactChecksumSidecar({
          repoRoot,
          artifactRepositoryPath,
        }),
      ).toMatchObject({
        valid: false,
        failures: ["authority_checksum_sidecar_parse_failed"],
      });

      writeFileSync(
        sidecarPath,
        `${artifactSha256}  docs/creative-decision-center/generated/another-proof.json\n`,
        "utf8",
      );
      expect(
        verifyAuthorityArtifactChecksumSidecar({
          repoRoot,
          artifactRepositoryPath,
        }),
      ).toMatchObject({
        valid: false,
        expectedSha256: artifactSha256,
        failures: ["authority_checksum_sidecar_path_mismatch"],
      });

      writeFileSync(
        sidecarPath,
        `${"0".repeat(64)}  ${artifactRepositoryPath}\n`,
        "utf8",
      );
      expect(
        verifyAuthorityArtifactChecksumSidecar({
          repoRoot,
          artifactRepositoryPath,
        }),
      ).toMatchObject({
        valid: false,
        expectedSha256: "0".repeat(64),
        failures: ["authority_checksum_sidecar_mismatch"],
      });

      writeFileSync(
        sidecarPath,
        `${artifactSha256}  ${artifactRepositoryPath}\n`,
        "utf8",
      );
      expect(
        verifyAuthorityArtifactChecksumSidecar({
          repoRoot,
          artifactRepositoryPath,
        }),
      ).toMatchObject({
        valid: true,
        actualSha256: artifactSha256,
        expectedSha256: artifactSha256,
        recordedArtifactPath: artifactRepositoryPath,
        failures: [],
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects self-consistent stale or contradictory scheduler-population artifact pairs", () => {
    const repoRoot = mkdtempSync(
      join(tmpdir(), "adsecute-population-artifact-"),
    );
    const artifactRepositoryPath =
      "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-all-current-population-compact.json";
    const artifactPath = join(repoRoot, artifactRepositoryPath);
    const sidecarPath = artifactPath.replace(/\.json$/, ".sha256");
    mkdirSync(dirname(artifactPath), { recursive: true });
    const writePair = (artifact: ReturnType<
      typeof validSchedulerPopulationCompactArtifact
    >) => {
      const content = `${JSON.stringify(artifact)}\n`;
      const checksum = createHash("sha256").update(content).digest("hex");
      writeFileSync(artifactPath, content, "utf8");
      writeFileSync(
        sidecarPath,
        `${checksum}  ${artifactRepositoryPath}\n`,
        "utf8",
      );
      return checksum;
    };
    const verify = () =>
      verifyCompactAuthorityArtifactFile({
        repoRoot,
        artifactRepositoryPath,
        expectedAsOfDate: "2026-07-19",
        mode: "scheduler_population",
      });

    try {
      const validArtifact = validSchedulerPopulationCompactArtifact();
      writePair(validArtifact);
      expect(verify()).toMatchObject({
        valid: true,
        failures: [],
        checksum: { valid: true },
        contractValidation: {
          schedulerPopulationValid: true,
          waveCoverageValid: true,
        },
      });

      const staleArtifact = structuredClone(validArtifact);
      staleArtifact.parameters.asOfDate = "2026-07-18";
      staleArtifact.generatedAt = "2026-07-18T03:15:00.000Z";
      writePair(staleArtifact);
      const staleProof = verify();
      expect(staleProof.checksum.valid).toBe(true);
      expect(staleProof.valid).toBe(false);
      expect(staleProof.failures).toEqual(
        expect.arrayContaining([
          "population_authority_as_of_mismatch",
          "population_authority_generation_date_mismatch",
        ]),
      );

      const contradictoryArtifact = structuredClone(validArtifact);
      contradictoryArtifact.releaseGate.checks.authorityProofOrLineageContradictions =
        1;
      contradictoryArtifact.waveCoverageProof.accounts[0]!.calibrationLineageValid =
        false;
      writePair(contradictoryArtifact);
      const contradictoryProof = verify();
      expect(contradictoryProof.checksum.valid).toBe(true);
      expect(contradictoryProof.valid).toBe(false);
      expect(contradictoryProof.failures).toEqual(
        expect.arrayContaining([
          "population_authority_release_gate_contract_invalid",
          "population_authority_proof_or_lineage_contradictions",
          "population_authority_scheduler_wave_coverage_invalid",
        ]),
      );

      const forgedManifestArtifact = structuredClone(validArtifact);
      forgedManifestArtifact.schedulerPopulationCoverage.expectedBusinesses[0]!.businessName =
        "Mutated Business";
      forgedManifestArtifact.schedulerPopulationCoverage.manifestHash =
        "a".repeat(64);
      forgedManifestArtifact.artifactProjection.schedulerPopulationManifestHash =
        "a".repeat(64);
      writePair(forgedManifestArtifact);
      expect(verify()).toMatchObject({
        valid: false,
        failures: expect.arrayContaining([
          "population_authority_scheduler_population_coverage_invalid",
        ]),
      });

      const incompleteWaveArtifact = structuredClone(validArtifact);
      incompleteWaveArtifact.waveCoverageProof.businesses[0]!.decisionJobRunId =
        "";
      incompleteWaveArtifact.waveCoverageProof.businesses[0]!.calibrationJobProviderAccountCount =
        0;
      incompleteWaveArtifact.waveCoverageProof.businesses[0]!.calibrationWaveReceiptCount =
        0;
      incompleteWaveArtifact.waveCoverageProof.accounts[0]!.calibrationReceiptCount =
        0;
      incompleteWaveArtifact.waveCoverageProof.accounts[0]!.hydrationReceiptCount =
        0;
      writePair(incompleteWaveArtifact);
      expect(verify()).toMatchObject({
        valid: false,
        failures: expect.arrayContaining([
          "population_authority_scheduler_wave_coverage_invalid",
        ]),
      });

      const incompleteProjectionArtifact = structuredClone(validArtifact);
      incompleteProjectionArtifact.artifactProjection.fullArtifactSha256 = "";
      incompleteProjectionArtifact.mediaBuyerRowAudit.rowsOmitted = false;
      writePair(incompleteProjectionArtifact);
      expect(verify()).toMatchObject({
        valid: false,
        failures: expect.arrayContaining([
          "population_authority_projection_contract_invalid",
        ]),
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects a checksum-consistent prior-date population artifact in a newly dated pair", () => {
    const repoRoot = mkdtempSync(
      join(tmpdir(), "adsecute-mixed-date-authority-artifact-"),
    );
    const plan = buildD061AuthorityArtifactPlan("2026-07-20");
    const artifactPath = join(repoRoot, plan.populationArtifactPath);
    const artifact = validSchedulerPopulationCompactArtifact();
    const content = `${JSON.stringify(artifact)}\n`;
    const checksum = createHash("sha256").update(content).digest("hex");
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, content, "utf8");
    writeFileSync(
      join(repoRoot, plan.populationSidecarPath),
      `${checksum}  ${plan.populationArtifactPath}\n`,
      "utf8",
    );

    try {
      const proof = verifyCompactAuthorityArtifactFile({
        repoRoot,
        artifactRepositoryPath: plan.populationArtifactPath,
        expectedAsOfDate: plan.authorityAsOfDate,
        mode: "scheduler_population",
      });
      expect(proof.checksum.valid).toBe(true);
      expect(proof.valid).toBe(false);
      expect(proof.failures).toEqual(
        expect.arrayContaining([
          "population_authority_as_of_mismatch",
          "population_authority_generation_date_mismatch",
        ]),
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("derives exact authority provenance exclusions and verifies the full source hash scope", () => {
    const repoRoot = process.cwd();
    const authorityAsOfDate = "2026-07-20";
    const plan = buildD061AuthorityArtifactPlan(authorityAsOfDate);
    const focusedArtifactPath =
      plan.focusedArtifactPath;
    const provenance = readAuthorityReplayCodeProvenance(
      {
        jsonOut: "/tmp/native-ad-authority-full.json",
        compactJsonOut: focusedArtifactPath,
        provenanceExcludePaths: [
          plan.populationArtifactPath,
          "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-16-compact.json",
          "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-compact.json",
          "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-all-current-population-compact.json",
        ],
      },
      repoRoot,
    );
    const validArtifact = { codeProvenance: provenance };

    expect(
      compactArtifactRepositoryContentParity({
        artifact: validArtifact,
        repoRoot,
        replayOutputPaths: [],
        authorityAsOfDate,
      }),
    ).toBe(true);

    const forgedExclusions = [
      ...provenance.repositoryContentManifest.excludedRepositoryPaths,
      "package.json",
    ].sort();
    const forgedManifest = buildRepositoryContentManifest(
      repoRoot,
      forgedExclusions,
    );
    expect(
      compactArtifactRepositoryContentParity({
        artifact: {
          codeProvenance: {
            ...provenance,
            repositoryContentManifest: forgedManifest,
          },
        },
        repoRoot,
        replayOutputPaths: [],
        authorityAsOfDate,
      }),
    ).toBe(false);

    const firstSourceFile = Object.keys(provenance.sourceFiles)[0]!;
    expect(
      compactArtifactRepositoryContentParity({
        artifact: {
          codeProvenance: {
            ...provenance,
            sourceFiles: {
              ...provenance.sourceFiles,
              [firstSourceFile]: "0".repeat(64),
            },
          },
        },
        repoRoot,
        replayOutputPaths: [],
        authorityAsOfDate,
      }),
    ).toBe(false);
  });

  it("proves that skipping an intermediate soft day would falsely confirm a later Cut", () => {
    const firstCut = applyLabelHysteresis("cut", null);
    const interveningKeep = applyLabelHysteresis("keep", {
      publishedLabel: firstCut.publishedLabel,
      rawLabel: firstCut.rawLabel,
    });
    const correctlyReplayedLaterCut = applyLabelHysteresis("cut", {
      publishedLabel: interveningKeep.publishedLabel,
      rawLabel: interveningKeep.rawLabel,
    });
    const incorrectlySkippedLaterCut = applyLabelHysteresis("cut", {
      publishedLabel: firstCut.publishedLabel,
      rawLabel: firstCut.rawLabel,
    });

    expect(firstCut).toMatchObject({
      publishedLabel: "keep",
      rawLabel: "cut",
      suppressed: true,
    });
    expect(interveningKeep).toMatchObject({
      publishedLabel: "keep",
      rawLabel: "keep",
      suppressed: false,
    });
    expect(correctlyReplayedLaterCut).toMatchObject({
      publishedLabel: "keep",
      rawLabel: "cut",
      suppressed: true,
    });
    expect(incorrectlySkippedLaterCut).toMatchObject({
      publishedLabel: "cut",
      rawLabel: "cut",
      suppressed: false,
    });
  });

  it("hard-codes the read-only transaction and production decision path, not a second calculator", () => {
    const source = readFileSync(
      "scripts/creative-decision-center/native-ad-account-aov-closed-window-replay.ts",
      "utf8",
    );

    expect(source).toContain(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(source).toContain("SET LOCAL statement_timeout = '30s'");
    expect(source).toContain("default_transaction_read_only=on");
    expect(source).toContain("computeNativeAdCalibrationBatch");
    expect(source).toContain("resolveAccountDecisionProfile");
    expect(source).toContain("computeNativeAdDecisions");
    expect(source).toContain("baselinePreviousLabels");
    expect(source).toContain("challengerPreviousLabels");
    expect(source).toContain("previousLabels: input.previousLabels");
    expect(source).toContain("selectSemanticRestatedTargetAtCutoff");
    expect(source).toContain(
      "targetAuthority: input.candidate.productionTarget",
    );
    expect(source).not.toContain("FROM business_target_packs");
    expect(source).not.toContain("provider_accounts.currency");
    expect(source).toContain(
      "effectiveStatus: candidate.decisionStatusProof.effectiveStatus",
    );
    expect(source).toContain('mode: "restated_daily_delivery"');
    expect(source).toContain('mode: "restated_neutral_medium"');
    expect(source).toContain("reviewOnlyCampaignContext");
    expect(source).toContain('campaignContextMode: "automatic"');
    expect(source).toContain('"restated_daily_hierarchy" as const');
    expect(source).toContain('source: "missing"');
    expect(source).toContain("if (candidate.scoreEligible) rows.push(row)");
    expect(source).toContain(
      "chronologicalIntegrityRows: chronologicalRows",
    );
    expect(source).toContain(
      "conflictingDuplicateFactGroups: deduplicated.conflictingDuplicateGroups",
    );
    expect(source).toContain(
      "consecutiveDailyCoverageComplete: chronologyGapResets === 0",
    );
    expect(source).toContain("buildRepositoryContentManifest");
    expect(source).toContain(
      "adsecute.meta.native-ad-account-aov-current-day-production-parity.v7",
    );
    expect(source).toContain(
      "COMPACT_REPLAY_PROOF_CONTRACT_VERSION",
    );
    expect(source).toContain(
      "authority_calibration_context_proof_commitment_invalid",
    );
    expect(source).toContain("input.expectedAccounts.length === 4");
    expect(source).toContain("expectedScopeSet.size === 4");
    expect(source).toContain("authority_exact_scope_mismatch");
    expect(source).toContain("authority_repository_content_manifest_mismatch");
    expect(source).toContain("authority_checksum_sidecar_missing");
    expect(source).toContain("authority_checksum_sidecar_mismatch");
    expect(source).toContain("populationAuthorityArtifactIntegrity");
    expect(source).toContain(
      'input.mode === "scheduler_population" ? "population_" : ""',
    );
    expect(source).toContain("`${populationPrefix}${failure}`");
    expect(source).toContain("temporaryPath: `${output.outputPath}.tmp`");
    expect(source).toContain(
      "assertClosedWindowReplayProvenanceStable(report.codeProvenance, args)",
    );
    expect(source).toContain(
      "renameSync(output.temporaryPath, output.outputPath)",
    );
  });

  it("deduplicates benign production-equivalent rows with different selectors and cutoff-safe timestamps", () => {
    const first = sourceRow();
    const equivalent = {
      ...first,
      sourceRowId: "source-b",
      finalizedAt: "2026-07-01T01:00:00.000Z",
      createdAt: "2026-06-01T02:00:00.000Z",
      updatedAt: "2026-07-01T01:00:00.000Z",
      campaignSourceRowId: "campaign-row-b",
      campaignCreatedAt: "2026-06-01T02:00:00.000Z",
      campaignUpdatedAt: "2026-07-01T01:00:00.000Z",
      adsetSourceRowId: "adset-row-b",
      adsetCreatedAt: "2026-06-01T02:00:00.000Z",
      adsetUpdatedAt: "2026-07-01T01:00:00.000Z",
    };

    expect(
      deduplicateD061RestatedFacts([equivalent, first], {
        cutoff: "2026-07-02T03:00:00.000Z",
      }),
    ).toMatchObject({
      facts: [{ sourceRowId: "source-a" }],
      conflictingDuplicateGroups: 0,
      unsafeDuplicateGroups: 0,
      duplicateSelectorRows: 1,
    });
  });

  it.each([
    [
      "pending truth",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        truthState: "PENDING",
      }),
    ],
    [
      "failed hierarchy",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        campaignValidationStatus: "FAILED",
      }),
    ],
    [
      "cutoff-late Ad fact",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        updatedAt: "2026-07-03T00:00:00.000Z",
      }),
    ],
    [
      "cutoff-late hierarchy",
      (row: NativeAdCalibrationSourceRow) => ({
        ...row,
        adsetUpdatedAt: "2026-07-03T00:00:00.000Z",
      }),
    ],
  ])("censors a production-equivalent duplicate with %s", (_label, mutate) => {
    const first = sourceRow();
    const unsafe = {
      ...mutate(first),
      sourceRowId: "source-b",
    };

    expect(
      deduplicateD061RestatedFacts([first, unsafe], {
        cutoff: "2026-07-02T03:00:00.000Z",
      }),
    ).toMatchObject({
      facts: [],
      conflictingDuplicateGroups: 0,
      unsafeDuplicateGroups: 1,
      unsafeDuplicateSourceRowIds: ["source-a", "source-b"],
    });
  });
});
