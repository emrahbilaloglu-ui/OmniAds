import { describe, expect, it } from "vitest";
import {
  d061StableHash,
  evaluateD061ClosedWindowGate as evaluateGate,
  type D061ClosedWindowReplayRow,
  type D061ReplayDecision,
} from "@/scripts/creative-decision-center/d061-account-aov-closed-window-gate";

const EXPECTED_ACCOUNTS = Array.from({ length: 4 }, (_, index) => ({
  key: `account_${index + 1}`,
  label: `Account ${index + 1}`,
  providerAccountId: `act_synthetic_${index + 1}`,
}));

function evaluateD061ClosedWindowGate(
  rows: readonly D061ClosedWindowReplayRow[],
  options: Omit<
    Parameters<typeof evaluateGate>[1],
    "chronologicalIntegrityRows" | "conflictingDuplicateFactGroups"
  > & {
    chronologicalIntegrityRows?: readonly D061ClosedWindowReplayRow[];
    conflictingDuplicateFactGroups?: number;
  } = {},
) {
  return evaluateGate(rows, {
    ...options,
    conflictingDuplicateFactGroups:
      options.conflictingDuplicateFactGroups ?? 0,
    chronologicalIntegrityRows: options.chronologicalIntegrityRows ?? rows,
    expectedAccountStrata: EXPECTED_ACCOUNTS,
  });
}

const keepDecision: D061ReplayDecision = {
  preAuthorityLabel: "keep",
  rawLabel: "keep",
  finalLabel: "keep",
  blockedActionType: null,
  authorityBlocker: null,
  confidence: 60,
  reason: "baseline",
};

const pendingCutDecision: D061ReplayDecision = {
  preAuthorityLabel: "cut",
  rawLabel: "cut",
  finalLabel: "keep",
  blockedActionType: "cut",
  authorityBlocker: null,
  confidence: 60,
  reason: "first D036 cut signal pending",
};

const cutDecision: D061ReplayDecision = {
  ...pendingCutDecision,
  finalLabel: "cut",
  blockedActionType: null,
  reason: "later D036 cut signal confirmed",
};

const scaleDecision: D061ReplayDecision = {
  ...keepDecision,
  preAuthorityLabel: "scale",
  rawLabel: "scale",
  finalLabel: "scale",
  reason: "scale",
};

const refreshDecision: D061ReplayDecision = {
  ...keepDecision,
  preAuthorityLabel: "refresh",
  rawLabel: "refresh",
  finalLabel: "refresh",
  reason: "refresh",
};

function row(input: {
  index: number;
  accountIndex?: number;
  baseline?: D061ReplayDecision;
  challenger?: D061ReplayDecision;
  forwardSpend?: number;
  forwardRevenue?: number;
  sourceMode?: D061ClosedWindowReplayRow["sourceMode"];
  sourceModeRestated?: boolean;
  currentScd0FieldsUsed?: string[];
  sourceRowsUpdatedAfterCutoff?: number;
  targetSource?: D061ClosedWindowReplayRow["target"]["source"];
  cutoffFallbackUsed?: boolean;
  oldTargetThirtyDayMetamorphicDrift?: boolean;
  preDecisionRoas?: number;
  opportunityMaturitySpend?: number | null;
  complete?: boolean;
  asOfDate?: string;
  executionError?: string | null;
}): D061ClosedWindowReplayRow {
  const account =
    EXPECTED_ACCOUNTS[
      input.accountIndex ?? input.index % EXPECTED_ACCOUNTS.length
    ]!;
  const asOfDate =
    input.asOfDate ??
    `2026-06-${String(1 + (input.index % 27)).padStart(2, "0")}`;
  const cohortKey = `${account.providerAccountId}:ad-${input.index}:${asOfDate}`;
  const sourceMode = input.sourceMode ?? "restated_ad_daily";
  const outcome = {
    complete: input.complete ?? true,
    windowStart: "2026-06-02",
    windowEnd: "2026-06-15",
    boundsValid: true,
    spend: input.forwardSpend ?? 100,
    purchases: 0,
    revenue: input.forwardRevenue ?? 0,
    forwardActionContaminated: false,
    actionCoverage: "complete_ad_and_parent_scopes" as const,
    accountDaysExpected: 14,
    accountDaysPresent: input.complete === false ? 13 : 14,
  };
  const result = {
    cohortKey,
    rowHash: d061StableHash(cohortKey),
    businessId: `business-${input.accountIndex ?? input.index % 4}`,
    businessName: account.label.replace(" Main", ""),
    providerAccountId: account.providerAccountId,
    adIdHash: d061StableHash(`ad-${input.index}`),
    asOfDate,
    sourceMode,
    sourceModeRestated:
      input.sourceModeRestated ?? sourceMode === "restated_ad_daily",
    currentScd0FieldsUsed: input.currentScd0FieldsUsed ?? [],
    sourceRowsUpdatedAfterCutoff:
      input.sourceRowsUpdatedAfterCutoff ??
      (sourceMode === "restated_ad_daily" ? 1 : 0),
    sourceRestatementProof: {
      candidateRowCount: 2,
      admittedFinalizedRowCount: 2,
      excludedNonFinalizedOrHierarchyRowCount: 0,
      proofHash: d061StableHash(`restatement-${input.index}`),
    },
    cutoffFallbackUsed: input.cutoffFallbackUsed ?? false,
    actionExposureAtCutoff: "untreated",
    actionCoverageAtCutoff: {
      status: "complete_ad_and_parent_scopes",
      receiptManifestHash: d061StableHash([]),
      receiptIds: [],
    },
    hierarchyContextAtCutoff: {
      status: "cutoff_safe",
      rowsAfterCutoff: 0,
      proofHash: d061StableHash(`hierarchy-${input.index}`),
    },
    decisionStatusProof: {
      mode: "restated_daily_delivery",
      exactAtCutoff: false,
      effectiveStatus: "ACTIVE",
      sourceRowId: `source-${input.index}`,
      sourceDate: asOfDate,
      proofHash: d061StableHash(`status-${input.index}`),
    },
    decisionCampaignContextProof: {
      mode: "restated_neutral_medium",
      exactAtCutoff: false,
      campaignId: `campaign-${input.index}`,
      kind: null,
      contextTrust: "medium",
      proofHash: d061StableHash(`campaign-context-${input.index}`),
    },
    target: {
      source: input.targetSource ?? "business_target_pack_history",
      exactAtCutoff: sourceMode !== "restated_ad_daily",
      semanticRestatedAtCutoff: sourceMode === "restated_ad_daily",
      effectiveAt: "2026-04-01T00:00:00.000Z",
      recordedAt: "2026-07-14T00:00:00.000Z",
      productionRecordedAt: `${cohortKey.slice(-10)}T03:00:00.000Z`,
      recordedAfterCutoff: sourceMode === "restated_ad_daily",
      targetRoas: 2,
      breakEvenRoas: 1.2,
      ageDays: 75,
    },
    preDecision: {
      spend: 500,
      purchases: 1,
      revenue: 400,
      roas: input.preDecisionRoas ?? 0.8,
    },
    accountAovProof: {
      status: "ready",
      basis: "physical_account_purchase_aov_90d",
      purchaseCount: 100,
      meanAov: 200,
      totalRevenue: 20_000,
      contradictoryRowCount: 0,
      evidenceHash: d061StableHash(`proof-${input.index}`),
    },
    calibrationProof: {
      batchExpectedCellCount: 2,
      batchQualityCounts: null,
      accountDimensionBinding: {
        rawRequested: {
          accountTimezone: "UTC",
          accountCurrency: "USD",
        },
        admissionBound: {
          accountTimezone: "UTC",
          accountCurrency: "USD",
        },
        timezoneAdmission: {
          status: "ready",
          accountTimezone: "UTC",
          manifestHash: d061StableHash(`timezone-${input.index}`),
        },
        currencyAdmission: {
          status: "ready",
          accountCurrency: "USD",
          manifestHash: d061StableHash(`currency-${input.index}`),
        },
      },
      requestedCellKey: {
        accountTimezone: "UTC",
        accountCurrency: "USD",
        objective: "OUTCOME_SALES",
        cohort: "purchase",
        optimizationContext: "goal=VALUE|event=PURCHASE",
      },
      batchCellKeys: [],
      exactCellMatched: true,
      exactCellQualityStatus: "ready",
      exactCellCutReady: true,
      exactCellCutReason: null,
    },
    opportunityMaturitySpend: input.opportunityMaturitySpend ?? 250,
    baseline: input.baseline ?? keepDecision,
    challenger: input.challenger ?? cutDecision,
    oldTargetThirtyDayMetamorphicDrift:
      input.oldTargetThirtyDayMetamorphicDrift ?? false,
    outcomes: {
      "3": {
        ...outcome,
        windowEnd: "2026-06-04",
        accountDaysExpected: 3,
        accountDaysPresent: input.complete === false ? 2 : 3,
      },
      "7": {
        ...outcome,
        windowEnd: "2026-06-08",
        accountDaysExpected: 7,
        accountDaysPresent: input.complete === false ? 6 : 7,
      },
      "14": outcome,
    },
    executionError: input.executionError ?? null,
  } satisfies D061ClosedWindowReplayRow;
  return result;
}

function passingRows() {
  return Array.from({ length: 120 }, (_, index) => row({ index }));
}

describe("D061 closed-window paired release gate", () => {
  it("treats positive spend plus zero revenue as a known loser and keeps restated evidence review-only", () => {
    const report = evaluateD061ClosedWindowGate(passingRows(), {
      bootstrapIterations: 50,
    });
    const locked = report.strata[0]!.windows["14"]!;

    expect(locked.challenger).toMatchObject({
      knownEmitted: 120,
      supported: 120,
      refuted: 0,
      opportunityPositive: 120,
      opportunityCaptured: 120,
      precision: 1,
      opportunityRecall: 1,
    });
    expect(report.integrityGate).toMatchObject({
      passed: true,
      exitCode: 0,
    });
    expect(report.historicalPromotionQualityGate.passed).toBe(true);
    expect(report.automationPromotionGate).toEqual(
      expect.objectContaining({
        passed: false,
        reason: "restated_history_is_review_only",
      }),
    );
    expect(report.classification).toBe(
      "retain_as_policy_contract_repair_review_only",
    );
  });

  it("fails integrity on a non-scored chronological execution error without changing quality denominators", () => {
    const scoredRows = passingRows();
    const hiddenErrorRow = row({
      index: 500,
      asOfDate: "2026-05-20",
      executionError: "forced chronological evaluation failure",
    });
    const report = evaluateD061ClosedWindowGate(scoredRows, {
      bootstrapIterations: 25,
      chronologicalIntegrityRows: [...scoredRows, hiddenErrorRow],
    });

    expect(report.fixedCohort.rows).toBe(120);
    expect(report.strata[0]!.windows["14"]!.challenger.cohortRows).toBe(120);
    expect(report.evidence).toMatchObject({
      chronologicalIntegrityRows: 121,
      chronologicalIntegrityUniqueRows: 121,
      fixedCohortRowsMissingFromIntegrityScope: 0,
      executionErrors: 1,
    });
    expect(report.integrityGate).toMatchObject({
      passed: false,
      exitCode: 1,
      failures: expect.arrayContaining(["execution_errors"]),
    });
    expect(report.classification).toBe("stop_and_fix");
  });

  it("fails integrity on non-scored chronological Cut and Scale/Refresh safety drift", () => {
    const scoredRows = passingRows();
    const hiddenAboveBreakEvenCut = row({
      index: 501,
      asOfDate: "2026-05-20",
      preDecisionRoas: 1.3,
      challenger: cutDecision,
    });
    const hiddenScaleDrift = row({
      index: 502,
      asOfDate: "2026-05-20",
      baseline: scaleDecision,
      challenger: keepDecision,
    });
    const hiddenRefreshDrift = row({
      index: 503,
      asOfDate: "2026-05-20",
      baseline: refreshDecision,
      challenger: keepDecision,
    });
    const report = evaluateD061ClosedWindowGate(scoredRows, {
      bootstrapIterations: 25,
      chronologicalIntegrityRows: [
        ...scoredRows,
        hiddenAboveBreakEvenCut,
        hiddenScaleDrift,
        hiddenRefreshDrift,
      ],
    });

    expect(report.evidence).toMatchObject({
      chronologicalIntegrityRows: 123,
      rawScaleDeltaRows: 1,
      rawRefreshDeltaRows: 1,
      aboveBreakEvenCutRows: 1,
    });
    expect(report.integrityGate.failures).toEqual(
      expect.arrayContaining([
        "raw_scale_drift",
        "raw_refresh_drift",
        "above_break_even_cut",
      ]),
    );
    expect(report.integrityGate.exitCode).toBe(1);
    expect(report.classification).toBe("stop_and_fix");
  });

  it("fails closed when the chronological integrity population is duplicate or misses a scored row", () => {
    const scoredRows = passingRows();
    const missingReport = evaluateD061ClosedWindowGate(scoredRows, {
      bootstrapIterations: 25,
      chronologicalIntegrityRows: scoredRows.slice(1),
    });
    const duplicateReport = evaluateD061ClosedWindowGate(scoredRows, {
      bootstrapIterations: 25,
      chronologicalIntegrityRows: [...scoredRows, scoredRows[0]!],
    });

    expect(missingReport.evidence.fixedCohortRowsMissingFromIntegrityScope).toBe(
      1,
    );
    expect(missingReport.integrityGate.failures).toContain(
      "fixed_cohort_missing_from_chronological_integrity_scope",
    );
    expect(duplicateReport.evidence).toMatchObject({
      chronologicalIntegrityRows: 121,
      chronologicalIntegrityUniqueRows: 120,
    });
    expect(duplicateReport.integrityGate.failures).toContain(
      "chronological_integrity_population_duplicates",
    );
  });

  it("fails integrity when canonical duplicate fact groups disagree", () => {
    const report = evaluateD061ClosedWindowGate(passingRows(), {
      bootstrapIterations: 25,
      conflictingDuplicateFactGroups: 1,
    });

    expect(report.evidence.conflictingDuplicateFactGroups).toBe(1);
    expect(report.integrityGate).toMatchObject({
      passed: false,
      exitCode: 1,
      required: {
        zeroConflictingDuplicateFactGroups: true,
      },
      failures: expect.arrayContaining(["conflicting_duplicate_fact_groups"]),
    });
    expect(report.classification).toBe("stop_and_fix");
  });

  it("keeps D036 warm-up rows out of every locked quality stratum", () => {
    const warmup = EXPECTED_ACCOUNTS.map((_, accountIndex) =>
      row({
        index: 120 + accountIndex,
        accountIndex,
        asOfDate: "2026-05-25",
        forwardRevenue: 200,
      }),
    );
    const report = evaluateD061ClosedWindowGate(
      [...passingRows(), ...warmup],
      {
        bootstrapIterations: 25,
      },
    );

    expect(report.fixedCohort.rows).toBe(124);
    expect(report.strata[0]?.fixedCohortRows).toBe(120);
    expect(report.strata.slice(1).map((stratum) => stratum.fixedCohortRows)).toEqual(
      [30, 30, 30, 30],
    );
    expect(report.historicalPromotionQualityGate.passed).toBe(true);
  });

  it("records missing consecutive days as a review-only quality rejection", () => {
    const report = evaluateD061ClosedWindowGate(passingRows(), {
      bootstrapIterations: 25,
      consecutiveDailyCoverageComplete: false,
    });

    expect(report.integrityGate).toMatchObject({ passed: true, exitCode: 0 });
    expect(report.historicalPromotionQualityGate.failures).toContain(
      "consecutive_daily_coverage_incomplete",
    );
    expect(report.classification).toBe("review_only_reject_promotion");
  });

  it("censors zero-forward-spend rows instead of claiming saved spend", () => {
    const rows = passingRows();
    rows[0] = row({ index: 0, forwardSpend: 0, forwardRevenue: 0 });
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });
    const score = report.strata[0]!.windows["14"]!.challenger;

    expect(score.censoredEmitted).toBe(1);
    expect(score.knownEmitted).toBe(119);
    expect(score.knownOpportunities).toBe(119);
  });

  it("counts only published final Cut: first signal is pending and a later signal is emitted", () => {
    const rows = passingRows();
    rows[0] = row({ index: 0, challenger: pendingCutDecision });
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });
    const score = report.strata[0]!.windows["14"]!.challenger;

    expect(rows[0]!.challenger.preAuthorityLabel).toBe("cut");
    expect(rows[0]!.challenger.finalLabel).toBe("keep");
    expect(rows[1]!.challenger.finalLabel).toBe("cut");
    expect(score.emitted).toBe(119);
    expect(score.opportunityCaptured).toBe(119);
    expect(report.strata[0]!.windows["14"]!.rawSignal.challenger).toMatchObject(
      {
        emitted: 120,
        knownEmitted: 120,
        supported: 120,
        opportunityCaptured: 120,
      },
    );
    expect(report.challengerRawCutRows).toHaveLength(120);
  });

  it("does not count an immature future loser as a Cut opportunity", () => {
    const rows = passingRows();
    rows[0] = row({ index: 0, opportunityMaturitySpend: 501 });
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });
    const score = report.strata[0]!.windows["14"]!.challenger;

    expect(score).toMatchObject({
      knownEmitted: 120,
      supported: 120,
      opportunityPositive: 119,
      opportunityCaptured: 119,
      opportunityRecall: 1,
    });
    expect(report.strata[0]!.windows["14"]!.mcnemar).toMatchObject({
      pairedSampleSize: 119,
    });
  });

  it("does not emit a pre-authority Cut that authority leaves non-Cut", () => {
    const rows = passingRows();
    rows[0] = row({
      index: 0,
      challenger: {
        ...pendingCutDecision,
        rawLabel: "diagnose",
        finalLabel: "diagnose",
        authorityBlocker: "source_freshness",
      },
    });
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });

    expect(report.strata[0]!.windows["14"]!.challenger.emitted).toBe(119);
  });

  it("fails a blanket Cut policy with one supported loser and 119 refuted winners", () => {
    const rows = passingRows().map((item, index) =>
      index === 0
        ? item
        : row({ index, forwardSpend: 100, forwardRevenue: 200 }),
    );
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });
    const observed = report.historicalPromotionQualityGate.observed;

    expect(observed).toMatchObject({
      lockedKnownEmitted: 120,
      lockedSupported: 1,
      lockedRefuted: 119,
    });
    expect(observed.lockedPrecision).toBeCloseTo(1 / 120);
    expect(report.historicalPromotionQualityGate.failures).toEqual(
      expect.arrayContaining([
        "locked_precision_below_0_92",
        "locked_precision_wilson_lower_below_0_85",
      ]),
    );
  });

  it("excludes incomplete 3/7/14 rows from every primary denominator", () => {
    const rows = passingRows();
    rows[0] = row({ index: 0, complete: false });
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });

    for (const windowDays of ["3", "7", "14"]) {
      expect(report.strata[0]!.windows[windowDays]!.challenger).toMatchObject({
        completeRows: 119,
        primaryRows: 119,
      });
    }
  });

  it("fails release review when account AOV creates an above-break-even Cut", () => {
    const rows = passingRows();
    rows[0] = row({ index: 0, preDecisionRoas: 1.2 });
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });

    expect(report.evidence.aboveBreakEvenCutRows).toBe(1);
    expect(report.integrityGate.failures).toContain("above_break_even_cut");
  });

  it("fails on any Scale or Refresh drift even when Cut metrics look good", () => {
    const rows = passingRows();
    rows[0] = row({
      index: 0,
      baseline: { ...keepDecision, rawLabel: "scale" },
    });
    rows[1] = row({
      index: 1,
      challenger: { ...cutDecision, rawLabel: "refresh" },
    });
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });

    expect(report.evidence.rawScaleDeltaRows).toBe(1);
    expect(report.evidence.rawRefreshDeltaRows).toBe(1);
    expect(report.integrityGate.failures).toEqual(
      expect.arrayContaining(["raw_scale_drift", "raw_refresh_drift"]),
    );
  });

  it("rejects current SCD0 or lookahead rows labeled as exact", () => {
    const rows = passingRows();
    rows[0] = row({
      index: 0,
      sourceMode: "cutoff_safe_raw_pit",
      sourceModeRestated: false,
      currentScd0FieldsUsed: ["provider_accounts.currency"],
      sourceRowsUpdatedAfterCutoff: 1,
    });
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });

    expect(report.evidence).toMatchObject({
      exactModeLookaheadRows: 1,
      exactModeCurrentScd0Rows: 1,
    });
    expect(report.integrityGate.failures).toEqual(
      expect.arrayContaining([
        "exact_mode_lookahead",
        "current_scd0_labeled_exact",
      ]),
    );
  });

  it("never lets explicitly restated lookahead evidence open automation", () => {
    const report = evaluateD061ClosedWindowGate(passingRows(), {
      bootstrapIterations: 25,
    });

    expect(report.evidence.restatedLookaheadRows).toBe(120);
    expect(report.evidence.restatedTargetRecordedAfterCutoffRows).toBe(120);
    expect(report.automationPromotionGate.passed).toBe(false);
    expect(report.sourceAuthority.laneB.mayOpenAutomation).toBe(false);
  });

  it("fails review when parsed cross-artifact parity is absent or stale", () => {
    const report = evaluateD061ClosedWindowGate(passingRows(), {
      bootstrapIterations: 25,
      crossArtifactParityValid: false,
    });

    expect(report.integrityGate.failures).toContain(
      "cross_artifact_parity_invalid",
    );
  });

  it("fails if target history falls back to a mutable current pack", () => {
    const rows = passingRows();
    rows[0] = row({
      index: 0,
      targetSource: "missing",
      cutoffFallbackUsed: true,
    });
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });

    expect(report.integrityGate.failures).toContain(
      "target_history_fallback",
    );
  });

  it("makes the 30-day target boundary a release-failing metamorphic drift", () => {
    const rows = passingRows();
    rows[0] = row({
      index: 0,
      oldTargetThirtyDayMetamorphicDrift: true,
    });
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });

    expect(report.evidence.oldTargetThirtyDayDriftRows).toBe(1);
    expect(report.integrityGate.failures).toContain(
      "old_target_30d_decision_drift",
    );
  });

  it("requires at least 100 locked known outcomes for measurable retain-as-policy evidence", () => {
    const report = evaluateD061ClosedWindowGate(passingRows().slice(0, 99), {
      bootstrapIterations: 25,
    });

    expect(report.integrityGate.passed).toBe(true);
    expect(report.historicalPromotionQualityGate.passed).toBe(false);
    expect(report.classification).toBe("review_only_reject_promotion");
    expect(report.historicalPromotionQualityGate.failures).toContain(
      "locked_known_outcomes_below_100",
    );
  });

  it("fails weak named accounts even when the aggregate cohort clears every quality threshold", () => {
    const rows = [
      ...Array.from({ length: 117 }, (_, index) =>
        row({ index, accountIndex: 0 }),
      ),
      row({
        index: 117,
        accountIndex: 1,
        forwardRevenue: 200,
      }),
      row({
        index: 118,
        accountIndex: 2,
        forwardRevenue: 200,
      }),
      row({
        index: 119,
        accountIndex: 3,
        forwardRevenue: 200,
      }),
    ];
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });
    const aggregate = report.strata[0]!.windows["14"]!.challenger;

    expect(aggregate.precision).toBeGreaterThanOrEqual(0.92);
    expect(aggregate.opportunityRecall).toBeGreaterThanOrEqual(0.92);
    expect(aggregate.precisionWilson95?.lower).toBeGreaterThanOrEqual(0.85);
    expect(report.evidence.namedAccountFailingStrata).toEqual([
      "account_2",
      "account_3",
      "account_4",
    ]);
    expect(report.historicalPromotionQualityGate.failures).toContain(
      "named_account_quality_or_coverage_failed",
    );
  });

  it("reports only the explicitly manifested account and excludes a sibling account", () => {
    const rows = passingRows();
    rows.push({
      ...row({ index: 120, accountIndex: 0 }),
      cohortKey: "sibling-account:ad:2026-06-01",
      providerAccountId: "act_synthetic_sibling",
    });
    const report = evaluateD061ClosedWindowGate(rows, {
      bootstrapIterations: 25,
    });
    const manifested = report.strata.find(
      (stratum) => stratum.key === EXPECTED_ACCOUNTS[0]!.key,
    );

    expect(manifested?.providerAccountId).toBe("act_synthetic_1");
    expect(manifested?.fixedCohortRows).toBe(30);
    expect(report.strata[0]?.fixedCohortRows).toBe(121);
  });
});
