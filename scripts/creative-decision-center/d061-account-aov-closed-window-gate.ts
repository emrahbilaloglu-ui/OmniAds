import { createHash } from "node:crypto";
import { clusteredMovingBlockBootstrap } from "@/lib/creative-decision-engine/simulation/clustered-moving-block-bootstrap";
import {
  pairedMcNemarFromCounts,
  wilsonScoreInterval,
} from "@/lib/creative-decision-engine/simulation/paired-binary-inference";
import type { NativeAdCalibrationQualityCounts } from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import type { DecisionLabel } from "@/lib/creative-decision-engine/types";

export const D061_CLOSED_OUTCOME_WINDOWS = [3, 7, 14] as const;
export type D061ClosedOutcomeWindowDays =
  (typeof D061_CLOSED_OUTCOME_WINDOWS)[number];

export const D061_LOCKED_TEST_START = "2026-06-01";
export const D061_LOCKED_TEST_END = "2026-06-27";

export interface D061ExpectedAccountStratum {
  key: string;
  label: string;
  providerAccountId: string;
}

export type D061HistoricalSourceMode =
  | "persisted_native_decision_input"
  | "cutoff_safe_raw_pit"
  | "restated_ad_daily";

export interface D061ReplayDecision {
  preAuthorityLabel: DecisionLabel;
  /** Native label after authority guards and before D036 hysteresis. */
  rawLabel: DecisionLabel;
  finalLabel: DecisionLabel;
  blockedActionType: DecisionLabel | null;
  authorityBlocker: string | null;
  confidence: number;
  reason: string;
}

export interface D061ClosedOutcome {
  complete: boolean;
  windowStart: string;
  windowEnd: string;
  boundsValid: boolean;
  spend: number;
  purchases: number;
  revenue: number;
  forwardActionContaminated: boolean;
  actionCoverage: "complete_ad_and_parent_scopes" | "unknown_parent_scopes";
  accountDaysExpected: number;
  accountDaysPresent: number;
}

export interface D061ClosedWindowReplayRow {
  cohortKey: string;
  rowHash: string;
  businessId: string;
  businessName: string;
  providerAccountId: string;
  adIdHash: string;
  asOfDate: string;
  sourceMode: D061HistoricalSourceMode;
  sourceModeRestated: boolean;
  currentScd0FieldsUsed: string[];
  sourceRowsUpdatedAfterCutoff: number;
  sourceRestatementProof: {
    candidateRowCount: number;
    admittedFinalizedRowCount: number;
    excludedNonFinalizedOrHierarchyRowCount: number;
    proofHash: string;
  };
  cutoffFallbackUsed: boolean;
  actionExposureAtCutoff: "untreated" | "acted_success" | "failed" | "dry_run";
  actionCoverageAtCutoff: {
    status: "complete_ad_and_parent_scopes" | "unknown_parent_scopes";
    receiptManifestHash: string;
    receiptIds: string[];
  };
  hierarchyContextAtCutoff: {
    status:
      "cutoff_safe" | "restated_daily_hierarchy" | "missing_unreconstructable";
    rowsAfterCutoff: number;
    proofHash: string;
  };
  decisionStatusProof: {
    mode: "cutoff_safe_entity_state_history" | "restated_daily_delivery";
    exactAtCutoff: boolean;
    effectiveStatus: string;
    sourceRowId: string;
    sourceDate: string;
    proofHash: string;
  };
  decisionCampaignContextProof: {
    mode: "restated_neutral_medium";
    exactAtCutoff: false;
    campaignId: string;
    kind: null;
    contextTrust: "medium";
    proofHash: string;
  };
  target: {
    source: "business_target_pack_history" | "missing";
    exactAtCutoff: boolean;
    semanticRestatedAtCutoff: boolean;
    effectiveAt: string | null;
    /** Actual immutable history timestamp; it is never clamped. */
    recordedAt: string | null;
    /** Timestamp supplied only to the restated calculation. */
    productionRecordedAt: string | null;
    recordedAfterCutoff: boolean;
    targetRoas: number | null;
    breakEvenRoas: number | null;
    ageDays: number | null;
  };
  preDecision: {
    spend: number;
    purchases: number;
    revenue: number;
    roas: number | null;
  };
  accountAovProof: {
    status:
      | "ready"
      | "insufficient_sample"
      | "contradictory_purchase_truth"
      | "unavailable";
      /*
        The basis vocabulary this frozen replay may observe.

        `observed_shopify_aov` joins it because the authority builder can now
        reach that basis; the replay itself is unchanged and its own gates still
        require `physical_account_purchase_aov_90d` where they did. Widening the
        type only lets a row say honestly which basis it saw.
      */
    basis:
      | "target_cpa"
      | "operator_aov"
      | "observed_shopify_aov"
      | "physical_account_purchase_aov_90d"
      | null;
    purchaseCount: number;
    meanAov: number | null;
    totalRevenue: number;
    contradictoryRowCount: number;
    evidenceHash: string;
  };
  calibrationProof: {
    batchExpectedCellCount: number | null;
    batchQualityCounts: NativeAdCalibrationQualityCounts | null;
    accountDimensionBinding: {
      rawRequested: {
        accountTimezone: string;
        accountCurrency: string;
      };
      admissionBound: {
        accountTimezone: string;
        accountCurrency: string;
      };
      timezoneAdmission: {
        status: string;
        accountTimezone: string | null;
        manifestHash: string;
      } | null;
      currencyAdmission: {
        status: string;
        accountCurrency: string | null;
        manifestHash: string;
      } | null;
    };
    requestedCellKey: {
      accountTimezone: string;
      accountCurrency: string;
      objective: string;
      cohort: "purchase";
      optimizationContext: string;
    };
    batchCellKeys: Array<{
      accountTimezone: string;
      accountCurrency: string;
      cellScope: string;
      objective: string;
      cohort: string;
      optimizationContext: string;
    }>;
    exactCellMatched: boolean;
    exactCellQualityStatus: string | null;
    exactCellCutReady: boolean | null;
    exactCellCutReason: string | null;
  };
  opportunityMaturitySpend: number | null;
  baseline: D061ReplayDecision;
  challenger: D061ReplayDecision;
  oldTargetThirtyDayMetamorphicDrift: boolean;
  outcomes: Record<string, D061ClosedOutcome>;
  executionError: string | null;
}

export interface D061ActionScore {
  cohortRows: number;
  completeRows: number;
  primaryRows: number;
  emitted: number;
  knownEmitted: number;
  supported: number;
  refuted: number;
  censoredEmitted: number;
  unknownEmitted: number;
  knownOpportunities: number;
  opportunityPositive: number;
  opportunityCaptured: number;
  precision: number | null;
  precisionWilson95: ReturnType<typeof wilsonScoreInterval>;
  opportunityRecall: number | null;
  recallWilson95: ReturnType<typeof wilsonScoreInterval>;
}

interface D061WindowScore {
  windowDays: D061ClosedOutcomeWindowDays;
  baseline: D061ActionScore;
  challenger: D061ActionScore;
  rawSignal: {
    baseline: D061ActionScore;
    challenger: D061ActionScore;
  };
  pairedOpportunityRecallDelta: {
    pointEstimate: number | null;
    lower95: number | null;
    upper95: number | null;
    iterations: number;
    validIterations: number;
  };
  mcnemar: ReturnType<typeof pairedMcNemarFromCounts>;
  safety: {
    aboveBreakEvenChallengerCutRows: number;
    baselineScaleToChallengerNonScaleRows: number;
    challengerScaleAddedRows: number;
    baselineRefreshToChallengerNonRefreshRows: number;
    challengerRefreshAddedRows: number;
  };
}

export interface D061GateEvaluationOptions {
  /** Production/release replay must retain the D047 default of 10,000. */
  bootstrapIterations?: number;
  /** Canonical source fact identities whose duplicate rows disagree. */
  conflictingDuplicateFactGroups: number;
  /** Parsed cross-artifact contract/release/source-parity proof. */
  crossArtifactParityValid?: boolean;
  /** Optional legacy presentation corroboration must be singular and match. */
  legacyTargetCorroborationValid?: boolean;
  /** Data-driven release support manifest; no account IDs are source literals. */
  expectedAccountStrata?: readonly D061ExpectedAccountStratum[];
  /** Available rows all advance D036; false records missing consecutive days. */
  consecutiveDailyCoverageComplete?: boolean;
  /** Release review uses the locked dates and full 14-day outcome ceiling. */
  lockedWindowExact?: boolean;
  /**
   * Every chronological evaluation that can advance D036 memory. Quality is
   * still scored only on inputRows; integrity and safety must cover this full
   * population.
   */
  chronologicalIntegrityRows: readonly D061ClosedWindowReplayRow[];
}

interface D061StratumReport {
  key: string;
  label: string;
  providerAccountId: string | null;
  fixedCohortRows: number;
  targetExactRows: number;
  targetSemanticRestatedRows: number;
  physicalAccountAovReadyRows: number;
  changedCutRows: number;
  changedDecisionRows: number;
  supportStatus: "sufficient" | "insufficient";
  supportReason: string | null;
  qualityFailures: string[];
  calibrationDistribution: {
    exactCellMatchedRows: number;
    exactCellMissingRows: number;
    batchExpectedCellCounts: Record<string, number>;
    exactCellQualityStatuses: Record<string, number>;
    exactCellCutReadiness: Record<string, number>;
    exactCellCutReasons: Record<string, number>;
  };
  decisionDistribution: {
    baseline: {
      preAuthorityLabels: Record<string, number>;
      rawLabels: Record<string, number>;
      finalLabels: Record<string, number>;
      authorityBlockers: Record<string, number>;
    };
    challenger: {
      preAuthorityLabels: Record<string, number>;
      rawLabels: Record<string, number>;
      finalLabels: Record<string, number>;
      authorityBlockers: Record<string, number>;
    };
  };
  windows: Record<string, D061WindowScore>;
}

export interface D061ClosedWindowGateReport {
  contractVersion: "adsecute.meta.d061-closed-window-gate.v3";
  classification:
    | "retain_as_policy_contract_repair_review_only"
    | "review_only_reject_promotion"
    | "stop_and_fix";
  sourceAuthority: {
    laneA: {
      sourceModes: readonly [
        "persisted_native_decision_input",
        "cutoff_safe_raw_pit",
      ];
      automationEligibleRows: number;
      status:
        | "promotion_evidence_available"
        | "insufficient_exact_or_persisted_evidence";
    };
    laneB: {
      sourceMode: "restated_ad_daily";
      reviewOnlyRows: number;
      mayOpenAutomation: false;
    };
  };
  fixedCohort: {
    rows: number;
    uniqueRows: number;
    duplicateRows: number;
    fixedBeforeVariants: true;
    inputHash: string;
  };
  evidence: {
    conflictingDuplicateFactGroups: number;
    chronologicalIntegrityRows: number;
    chronologicalIntegrityUniqueRows: number;
    chronologicalIntegrityManifestHash: string;
    fixedCohortRowsMissingFromIntegrityScope: number;
    executionErrors: number;
    targetHistoryFallbackRows: number;
    exactModeLookaheadRows: number;
    exactModeCurrentScd0Rows: number;
    restatedLookaheadRows: number;
    restatedTargetRecordedAfterCutoffRows: number;
    hierarchyContextMissingRows: number;
    actionCoverageUnknownRows: number;
    mixedLaneRows: number;
    oldTargetThirtyDayDriftRows: number;
    namedAccountFailingStrata: string[];
    physicalAccountAovChangedCutRows: number;
    rawScaleDeltaRows: number;
    rawRefreshDeltaRows: number;
    aboveBreakEvenCutRows: number;
  };
  strata: D061StratumReport[];
  integrityGate: {
    passed: boolean;
    exitCode: 0 | 1;
    required: {
      zeroConflictingDuplicateFactGroups: true;
      zeroExecutionErrors: true;
      uniqueChronologicalIntegrityPopulation: true;
      fixedCohortCoveredByChronologicalIntegrityPopulation: true;
      validExpectedAccountManifest: true;
      uniqueFixedCohort: true;
      zeroCutoffFallbackOrUnlabeledLookahead: true;
      zeroCurrentScd0LabeledExact: true;
      noLanePooling: true;
      completeHierarchyAndActionCoverage: true;
      zeroOldTargetThirtyDayDrift: true;
      exactLockedWindow: true;
      zeroScaleRefreshDrift: true;
      zeroAboveBreakEvenCut: true;
      d061AxisExercised: true;
      crossArtifactParityRequired: true;
      legacyTargetCorroborationMustMatch: true;
    };
    failures: string[];
  };
  historicalPromotionQualityGate: {
    passed: boolean;
    required: {
      minimumLockedKnownOutcomes: 100;
      minimumLockedPrecision: 0.92;
      minimumLockedRecall: 0.92;
      minimumLockedPrecisionWilsonLower95: 0.85;
      pairedRecallNoninferiorityMargin: -0.02;
      allNamedAccountsCovered: true;
      allNamedAccountsMeetQualityThresholds: true;
      minimumNamedAccountKnownOutcomes: 20;
      consecutiveDailyCoverageComplete: true;
      laneBOnly: true;
    };
    observed: {
      lockedKnownOutcomes: number;
      lockedCompleteRows: number;
      lockedPrimaryRows: number;
      lockedKnownEmitted: number;
      lockedSupported: number;
      lockedRefuted: number;
      lockedOpportunityPositive: number;
      lockedOpportunityCaptured: number;
      lockedPrecision: number | null;
      lockedPrecisionWilsonLower95: number | null;
      lockedRecall: number | null;
      pairedRecallLower95: number | null;
    };
    failures: string[];
  };
  automationPromotionGate: {
    passed: false;
    reason:
      | "restated_history_is_review_only"
      | "exact_or_persisted_d047_gate_not_met";
    statisticalThresholds: {
      minimumKnownOutcomes: 100;
      minimumPrecision: 0.92;
      minimumRecall: 0.92;
      minimumPrecisionWilsonLower95: 0.85;
      pairedRecallNoninferiorityMargin: -0.02;
      zeroSafetyViolations: true;
    };
  };
  changedDecisionRows: Array<{
    rowHash: string;
    businessName: string;
    providerAccountId: string;
    adIdHash: string;
    asOfDate: string;
    sourceMode: D061HistoricalSourceMode;
    targetEffectiveAt: string | null;
    targetAgeDays: number | null;
    preDecision: D061ClosedWindowReplayRow["preDecision"];
    accountAovProof: D061ClosedWindowReplayRow["accountAovProof"];
    baseline: D061ReplayDecision;
    challenger: D061ReplayDecision;
    outcomes: D061ClosedWindowReplayRow["outcomes"];
  }>;
  calibrationFailureSamples: Array<{
    rowHash: string;
    businessName: string;
    providerAccountId: string;
    asOfDate: string;
    sourceRestatementProof: D061ClosedWindowReplayRow["sourceRestatementProof"];
    calibrationProof: D061ClosedWindowReplayRow["calibrationProof"];
    accountAovProof: D061ClosedWindowReplayRow["accountAovProof"];
    executionError: string | null;
  }>;
  challengerRawCutRows: Array<{
    rowHash: string;
    businessName: string;
    providerAccountId: string;
    adIdHash: string;
    asOfDate: string;
    target: D061ClosedWindowReplayRow["target"];
    preDecision: D061ClosedWindowReplayRow["preDecision"];
    calibrationProof: D061ClosedWindowReplayRow["calibrationProof"];
    accountAovProof: D061ClosedWindowReplayRow["accountAovProof"];
    challenger: D061ReplayDecision;
    outcomes: D061ClosedWindowReplayRow["outcomes"];
  }>;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function d061StableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function decisionCut(decision: D061ReplayDecision): boolean {
  return decision.finalLabel === "cut";
}

function targetAuthorityUsable(row: D061ClosedWindowReplayRow): boolean {
  if (row.target.exactAtCutoff) return !row.sourceModeRestated;
  return (
    row.sourceModeRestated &&
    row.target.semanticRestatedAtCutoff &&
    row.target.productionRecordedAt !== null
  );
}

function outcomeCoverageValid(
  outcome: D061ClosedOutcome,
  windowDays: D061ClosedOutcomeWindowDays,
): boolean {
  const computedComplete =
    outcome.boundsValid &&
    outcome.accountDaysExpected === windowDays &&
    outcome.accountDaysPresent === outcome.accountDaysExpected;
  return outcome.complete === computedComplete && computedComplete;
}

function primaryRowEligible(
  row: D061ClosedWindowReplayRow,
  outcome: D061ClosedOutcome,
  windowDays: D061ClosedOutcomeWindowDays,
): boolean {
  return (
    row.executionError === null &&
    targetAuthorityUsable(row) &&
    row.target.breakEvenRoas !== null &&
    row.actionExposureAtCutoff === "untreated" &&
    row.actionCoverageAtCutoff.status === "complete_ad_and_parent_scopes" &&
    (row.hierarchyContextAtCutoff.status === "cutoff_safe" ||
      (row.sourceModeRestated &&
        row.hierarchyContextAtCutoff.status === "restated_daily_hierarchy")) &&
    outcome.actionCoverage === "complete_ad_and_parent_scopes" &&
    outcomeCoverageValid(outcome, windowDays) &&
    !outcome.forwardActionContaminated
  );
}

function scoreAction(
  rows: readonly D061ClosedWindowReplayRow[],
  windowDays: D061ClosedOutcomeWindowDays,
  side: "baseline" | "challenger",
  labelSource: "published" | "raw" = "published",
): D061ActionScore {
  let completeRows = 0;
  let primaryRows = 0;
  let emitted = 0;
  let knownEmitted = 0;
  let supported = 0;
  let refuted = 0;
  let censoredEmitted = 0;
  let unknownEmitted = 0;
  let knownOpportunities = 0;
  let opportunityPositive = 0;
  let opportunityCaptured = 0;

  for (const row of rows) {
    const outcome = row.outcomes[String(windowDays)];
    if (!outcome || !outcomeCoverageValid(outcome, windowDays)) continue;
    completeRows += 1;
    const primary = primaryRowEligible(row, outcome, windowDays);
    if (!primary) continue;
    primaryRows += 1;
    const cut =
      labelSource === "published"
        ? decisionCut(row[side])
        : row[side].rawLabel === "cut";
    if (cut) emitted += 1;
    if (outcome.spend <= 0) {
      if (cut) censoredEmitted += 1;
      continue;
    }
    const outcomeRoas = outcome.revenue / outcome.spend;
    const loser = outcomeRoas < row.target.breakEvenRoas!;
    const mature =
      row.opportunityMaturitySpend !== null &&
      row.preDecision.spend >= row.opportunityMaturitySpend;
    knownOpportunities += 1;
    if (mature && loser) {
      opportunityPositive += 1;
      if (cut) opportunityCaptured += 1;
    }
    if (!cut) continue;
    knownEmitted += 1;
    if (loser) supported += 1;
    else refuted += 1;
  }

  return {
    cohortRows: rows.length,
    completeRows,
    primaryRows,
    emitted,
    knownEmitted,
    supported,
    refuted,
    censoredEmitted,
    unknownEmitted,
    knownOpportunities,
    opportunityPositive,
    opportunityCaptured,
    precision: ratio(supported, knownEmitted),
    precisionWilson95: wilsonScoreInterval(supported, knownEmitted),
    opportunityRecall: ratio(opportunityCaptured, opportunityPositive),
    recallWilson95: wilsonScoreInterval(
      opportunityCaptured,
      opportunityPositive,
    ),
  };
}

function pairedRecallInference(
  rows: readonly D061ClosedWindowReplayRow[],
  windowDays: D061ClosedOutcomeWindowDays,
  bootstrapIterations: number,
) {
  const opportunityRows = rows.flatMap((row) => {
    const outcome = row.outcomes[String(windowDays)];
    if (
      row.executionError !== null ||
      !targetAuthorityUsable(row) ||
      row.target.breakEvenRoas === null ||
      row.actionExposureAtCutoff !== "untreated" ||
      !outcome ||
      !primaryRowEligible(row, outcome, windowDays) ||
      outcome.spend <= 0 ||
      row.opportunityMaturitySpend === null ||
      row.preDecision.spend < row.opportunityMaturitySpend ||
      outcome.revenue / outcome.spend >= row.target.breakEvenRoas
    ) {
      return [];
    }
    return [
      {
        businessId: row.businessId,
        entityId: `${row.providerAccountId}:${row.adIdHash}`,
        date: row.asOfDate,
        baselineCaptured: decisionCut(row.baseline),
        challengerCaptured: decisionCut(row.challenger),
      },
    ];
  });
  let bothCorrect = 0;
  let baselineOnlyCorrect = 0;
  let candidateOnlyCorrect = 0;
  let bothWrong = 0;
  for (const row of opportunityRows) {
    if (row.baselineCaptured && row.challengerCaptured) bothCorrect += 1;
    else if (row.baselineCaptured) baselineOnlyCorrect += 1;
    else if (row.challengerCaptured) candidateOnlyCorrect += 1;
    else bothWrong += 1;
  }
  const mcnemar = pairedMcNemarFromCounts({
    bothCorrect,
    baselineOnlyCorrect,
    candidateOnlyCorrect,
    bothWrong,
  });
  if (opportunityRows.length === 0) {
    return {
      pairedOpportunityRecallDelta: {
        pointEstimate: null,
        lower95: null,
        upper95: null,
        iterations: bootstrapIterations,
        validIterations: 0,
      },
      mcnemar,
    };
  }
  const bootstrap = clusteredMovingBlockBootstrap(opportunityRows, {
    getBusinessId: (row) => row.businessId,
    getEntityId: (row) => row.entityId,
    getDate: (row) => row.date,
    statistic: (sample) =>
      sample.length === 0
        ? null
        : sample.reduce(
            (sum, item) =>
              sum +
              Number(item.observation.challengerCaptured) -
              Number(item.observation.baselineCaptured),
            0,
          ) / sample.length,
    seed: `D061:${windowDays}:paired-opportunity-recall`,
    iterations: bootstrapIterations,
    blockLengthDays: 7,
    confidenceLevel: 0.95,
  });
  return {
    pairedOpportunityRecallDelta: {
      pointEstimate: bootstrap.pointEstimate,
      lower95: bootstrap.lower,
      upper95: bootstrap.upper,
      iterations: bootstrap.iterations,
      validIterations: bootstrap.validIterations,
    },
    mcnemar,
  };
}

function safetyForRows(
  rows: readonly D061ClosedWindowReplayRow[],
): D061WindowScore["safety"] {
  return {
    aboveBreakEvenChallengerCutRows: rows.filter(
      (row) =>
        decisionCut(row.challenger) &&
        row.preDecision.roas !== null &&
        row.target.breakEvenRoas !== null &&
        row.preDecision.roas >= row.target.breakEvenRoas,
    ).length,
    baselineScaleToChallengerNonScaleRows: rows.filter(
      (row) =>
        row.baseline.rawLabel === "scale" &&
        row.challenger.rawLabel !== "scale",
    ).length,
    challengerScaleAddedRows: rows.filter(
      (row) =>
        row.baseline.rawLabel !== "scale" &&
        row.challenger.rawLabel === "scale",
    ).length,
    baselineRefreshToChallengerNonRefreshRows: rows.filter(
      (row) =>
        row.baseline.rawLabel === "refresh" &&
        row.challenger.rawLabel !== "refresh",
    ).length,
    challengerRefreshAddedRows: rows.filter(
      (row) =>
        row.baseline.rawLabel !== "refresh" &&
        row.challenger.rawLabel === "refresh",
    ).length,
  };
}

function scoreWindow(
  rows: readonly D061ClosedWindowReplayRow[],
  windowDays: D061ClosedOutcomeWindowDays,
  bootstrapIterations: number,
): D061WindowScore {
  const paired = pairedRecallInference(rows, windowDays, bootstrapIterations);
  return {
    windowDays,
    baseline: scoreAction(rows, windowDays, "baseline"),
    challenger: scoreAction(rows, windowDays, "challenger"),
    rawSignal: {
      baseline: scoreAction(rows, windowDays, "baseline", "raw"),
      challenger: scoreAction(rows, windowDays, "challenger", "raw"),
    },
    pairedOpportunityRecallDelta: paired.pairedOpportunityRecallDelta,
    mcnemar: paired.mcnemar,
    safety: safetyForRows(rows),
  };
}

function countValues(
  values: readonly (string | null)[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? "none";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function decisionDistribution(
  rows: readonly D061ClosedWindowReplayRow[],
  side: "baseline" | "challenger",
) {
  return {
    preAuthorityLabels: countValues(
      rows.map((row) => row[side].preAuthorityLabel),
    ),
    rawLabels: countValues(rows.map((row) => row[side].rawLabel)),
    finalLabels: countValues(rows.map((row) => row[side].finalLabel)),
    authorityBlockers: countValues(
      rows.map((row) => row[side].authorityBlocker),
    ),
  };
}

function lockedStratumQualityFailures(score: D061WindowScore): string[] {
  const failures: string[] = [];
  if (score.challenger.knownOpportunities < 20) {
    failures.push("known_outcomes_below_20");
  }
  if (
    score.challenger.precision === null ||
    score.challenger.precision < 0.92
  ) {
    failures.push("precision_below_0_92");
  }
  if (
    score.challenger.opportunityRecall === null ||
    score.challenger.opportunityRecall < 0.92
  ) {
    failures.push("recall_below_0_92");
  }
  if (
    score.challenger.precisionWilson95 === null ||
    score.challenger.precisionWilson95.lower < 0.85
  ) {
    failures.push("precision_wilson_lower_below_0_85");
  }
  if (
    score.pairedOpportunityRecallDelta.lower95 === null ||
    score.pairedOpportunityRecallDelta.lower95 <= -0.02
  ) {
    failures.push("paired_recall_noninferiority_not_met");
  }
  return failures;
}

function stratumReport(input: {
  key: D061StratumReport["key"];
  label: string;
  providerAccountId: string | null;
  rows: readonly D061ClosedWindowReplayRow[];
  bootstrapIterations: number;
}): D061StratumReport {
  const changedDecisionRows = input.rows.filter(
    (row) =>
      row.baseline.preAuthorityLabel !== row.challenger.preAuthorityLabel ||
      row.baseline.finalLabel !== row.challenger.finalLabel,
  ).length;
  const windows = Object.fromEntries(
    D061_CLOSED_OUTCOME_WINDOWS.map((windowDays) => [
      String(windowDays),
      scoreWindow(input.rows, windowDays, input.bootstrapIterations),
    ]),
  ) as Record<string, D061WindowScore>;
  const locked = windows["14"]!;
  const qualityFailures = lockedStratumQualityFailures(locked);
  const supportStatus =
    qualityFailures.length === 0 ? "sufficient" : "insufficient";
  return {
    key: input.key,
    label: input.label,
    providerAccountId: input.providerAccountId,
    fixedCohortRows: input.rows.length,
    targetExactRows: input.rows.filter((row) => row.target.exactAtCutoff)
      .length,
    targetSemanticRestatedRows: input.rows.filter(
      (row) => row.target.semanticRestatedAtCutoff,
    ).length,
    physicalAccountAovReadyRows: input.rows.filter(
      (row) =>
        row.accountAovProof.status === "ready" &&
        row.accountAovProof.basis === "physical_account_purchase_aov_90d",
    ).length,
    changedCutRows: input.rows.filter(
      (row) =>
        row.baseline.rawLabel !== "cut" && row.challenger.rawLabel === "cut",
    ).length,
    changedDecisionRows,
    supportStatus,
    supportReason:
      supportStatus === "sufficient" ? null : qualityFailures.join(","),
    qualityFailures,
    calibrationDistribution: {
      exactCellMatchedRows: input.rows.filter(
        (row) => row.calibrationProof.exactCellMatched,
      ).length,
      exactCellMissingRows: input.rows.filter(
        (row) => !row.calibrationProof.exactCellMatched,
      ).length,
      batchExpectedCellCounts: countValues(
        input.rows.map((row) =>
          row.calibrationProof.batchExpectedCellCount === null
            ? null
            : String(row.calibrationProof.batchExpectedCellCount),
        ),
      ),
      exactCellQualityStatuses: countValues(
        input.rows.map((row) => row.calibrationProof.exactCellQualityStatus),
      ),
      exactCellCutReadiness: countValues(
        input.rows.map((row) =>
          row.calibrationProof.exactCellCutReady === null
            ? null
            : String(row.calibrationProof.exactCellCutReady),
        ),
      ),
      exactCellCutReasons: countValues(
        input.rows.map((row) => row.calibrationProof.exactCellCutReason),
      ),
    },
    decisionDistribution: {
      baseline: decisionDistribution(input.rows, "baseline"),
      challenger: decisionDistribution(input.rows, "challenger"),
    },
    windows,
  };
}

function sourceAuthorityEligible(row: D061ClosedWindowReplayRow): boolean {
  return (
    !row.sourceModeRestated &&
    (row.sourceMode === "persisted_native_decision_input" ||
      row.sourceMode === "cutoff_safe_raw_pit") &&
    row.currentScd0FieldsUsed.length === 0 &&
    row.sourceRowsUpdatedAfterCutoff === 0 &&
    !row.cutoffFallbackUsed
  );
}

export function evaluateD061ClosedWindowGate(
  inputRows: readonly D061ClosedWindowReplayRow[],
  options: D061GateEvaluationOptions,
): D061ClosedWindowGateReport {
  const bootstrapIterations = options.bootstrapIterations ?? 10_000;
  if (!Number.isInteger(bootstrapIterations) || bootstrapIterations <= 0) {
    throw new TypeError("bootstrapIterations must be a positive integer");
  }
  if (
    !Number.isInteger(options.conflictingDuplicateFactGroups) ||
    options.conflictingDuplicateFactGroups < 0
  ) {
    throw new TypeError(
      "conflictingDuplicateFactGroups must be a non-negative integer",
    );
  }
  const rows = [...inputRows].sort(
    (left, right) =>
      left.cohortKey.localeCompare(right.cohortKey) ||
      left.rowHash.localeCompare(right.rowHash),
  );
  const chronologicalIntegrityRows = [
    ...options.chronologicalIntegrityRows,
  ].sort(
    (left, right) =>
      left.cohortKey.localeCompare(right.cohortKey) ||
      left.rowHash.localeCompare(right.rowHash),
  );
  const uniqueRows = new Set(rows.map((row) => row.cohortKey)).size;
  const chronologicalIntegrityUniqueRows = new Set(
    chronologicalIntegrityRows.map((row) => row.cohortKey),
  ).size;
  const chronologicalIntegrityIdentities = new Set(
    chronologicalIntegrityRows.map(
      (row) => `${row.cohortKey}:${row.rowHash}`,
    ),
  );
  const fixedCohortRowsMissingFromIntegrityScope = rows.filter(
    (row) =>
      !chronologicalIntegrityIdentities.has(`${row.cohortKey}:${row.rowHash}`),
  ).length;
  const exactModeRows = chronologicalIntegrityRows.filter(
    (row) => !row.sourceModeRestated,
  );
  const laneBRows = rows.filter(
    (row) => row.sourceModeRestated && row.sourceMode === "restated_ad_daily",
  );
  const chronologicalLaneBRows = chronologicalIntegrityRows.filter(
    (row) => row.sourceModeRestated && row.sourceMode === "restated_ad_daily",
  );
  const mixedLaneRows =
    chronologicalLaneBRows.length > 0 ? exactModeRows.length : 0;
  const expectedAccountStrata = [...(options.expectedAccountStrata ?? [])];
  const manifestKeys = new Set<string>();
  const manifestAccountIds = new Set<string>();
  const expectedAccountManifestValid = expectedAccountStrata.every(
    (stratum) => {
      const valid =
        stratum.key.trim().length > 0 &&
        stratum.key !== "full_cohort" &&
        stratum.label.trim().length > 0 &&
        stratum.providerAccountId.trim().length > 0 &&
        !manifestKeys.has(stratum.key) &&
        !manifestAccountIds.has(stratum.providerAccountId);
      manifestKeys.add(stratum.key);
      manifestAccountIds.add(stratum.providerAccountId);
      return valid;
    },
  );
  const lockedRows = laneBRows.filter(
    (row) =>
      row.asOfDate >= D061_LOCKED_TEST_START &&
      row.asOfDate <= D061_LOCKED_TEST_END,
  );
  const allLaneB = stratumReport({
    key: "all_available_history",
    label: "All available Lane B history",
    providerAccountId: null,
    rows: laneBRows,
    bootstrapIterations,
  });
  const strata: D061StratumReport[] = [
    stratumReport({
      key: "full_cohort",
      label: "Locked fixed cohort",
      providerAccountId: null,
      rows: lockedRows,
      bootstrapIterations,
    }),
    ...expectedAccountStrata.map((stratum) =>
      stratumReport({
        key: stratum.key,
        label: stratum.label,
        providerAccountId: stratum.providerAccountId,
        rows: lockedRows.filter(
          (row) => row.providerAccountId === stratum.providerAccountId,
        ),
        bootstrapIterations,
      }),
    ),
  ];
  const locked = scoreWindow(lockedRows, 14, bootstrapIterations);
  const namedAccountFailingStrata = strata
    .slice(1)
    .filter((stratum) => stratum.supportStatus === "insufficient")
    .map((stratum) => stratum.key);
  const exactModeLookaheadRows = exactModeRows.filter(
    (row) => row.sourceRowsUpdatedAfterCutoff > 0,
  ).length;
  const exactModeCurrentScd0Rows = exactModeRows.filter(
    (row) => row.currentScd0FieldsUsed.length > 0,
  ).length;
  // A missing pre-effective target is honest unknown history, not a fallback.
  // Only an actual mutable/current projection (or older-generation fallback)
  // is release-failing.
  const targetHistoryFallbackRows = chronologicalIntegrityRows.filter(
    (row) => row.cutoffFallbackUsed,
  ).length;
  const chronologicalSafety = safetyForRows(chronologicalIntegrityRows);
  const rawScaleDeltaRows =
    chronologicalSafety.baselineScaleToChallengerNonScaleRows +
    chronologicalSafety.challengerScaleAddedRows;
  const rawRefreshDeltaRows =
    chronologicalSafety.baselineRefreshToChallengerNonRefreshRows +
    chronologicalSafety.challengerRefreshAddedRows;
  const physicalAccountAovChangedCutRows = lockedRows.filter(
    (row) =>
      row.accountAovProof.status === "ready" &&
      row.accountAovProof.basis === "physical_account_purchase_aov_90d" &&
      row.baseline.rawLabel !== "cut" &&
      row.challenger.rawLabel === "cut",
  ).length;
  const evidence = {
    conflictingDuplicateFactGroups: options.conflictingDuplicateFactGroups,
    chronologicalIntegrityRows: chronologicalIntegrityRows.length,
    chronologicalIntegrityUniqueRows,
    chronologicalIntegrityManifestHash: d061StableHash(
      chronologicalIntegrityRows.map((row) => ({
        cohortKey: row.cohortKey,
        rowHash: row.rowHash,
      })),
    ),
    fixedCohortRowsMissingFromIntegrityScope,
    executionErrors: chronologicalIntegrityRows.filter(
      (row) => row.executionError !== null,
    ).length,
    targetHistoryFallbackRows,
    exactModeLookaheadRows,
    exactModeCurrentScd0Rows,
    restatedLookaheadRows: chronologicalIntegrityRows.filter(
      (row) => row.sourceModeRestated && row.sourceRowsUpdatedAfterCutoff > 0,
    ).length,
    restatedTargetRecordedAfterCutoffRows: chronologicalIntegrityRows.filter(
      (row) => row.sourceModeRestated && row.target.recordedAfterCutoff,
    ).length,
    hierarchyContextMissingRows: chronologicalIntegrityRows.filter(
      (row) =>
        row.hierarchyContextAtCutoff.status === "missing_unreconstructable",
    ).length,
    actionCoverageUnknownRows: chronologicalIntegrityRows.filter(
      (row) =>
        row.actionCoverageAtCutoff.status === "unknown_parent_scopes" ||
        D061_CLOSED_OUTCOME_WINDOWS.some(
          (windowDays) =>
            row.outcomes[String(windowDays)]?.actionCoverage ===
            "unknown_parent_scopes",
        ),
    ).length,
    mixedLaneRows,
    oldTargetThirtyDayDriftRows: chronologicalIntegrityRows.filter(
      (row) => row.oldTargetThirtyDayMetamorphicDrift,
    ).length,
    namedAccountFailingStrata,
    physicalAccountAovChangedCutRows,
    rawScaleDeltaRows,
    rawRefreshDeltaRows,
    aboveBreakEvenCutRows:
      chronologicalSafety.aboveBreakEvenChallengerCutRows,
  };
  const integrityFailures: string[] = [];
  const qualityFailures: string[] = [];
  if (evidence.conflictingDuplicateFactGroups > 0)
    integrityFailures.push("conflicting_duplicate_fact_groups");
  if (evidence.executionErrors > 0)
    integrityFailures.push("execution_errors");
  if (
    evidence.chronologicalIntegrityRows !==
    evidence.chronologicalIntegrityUniqueRows
  ) {
    integrityFailures.push("chronological_integrity_population_duplicates");
  }
  if (evidence.fixedCohortRowsMissingFromIntegrityScope > 0) {
    integrityFailures.push(
      "fixed_cohort_missing_from_chronological_integrity_scope",
    );
  }
  if (!expectedAccountManifestValid || expectedAccountStrata.length === 0)
    integrityFailures.push("expected_account_manifest_missing_or_invalid");
  if (rows.length !== uniqueRows)
    integrityFailures.push("duplicate_fixed_cohort_rows");
  if (evidence.targetHistoryFallbackRows > 0)
    integrityFailures.push("target_history_fallback");
  if (evidence.exactModeLookaheadRows > 0)
    integrityFailures.push("exact_mode_lookahead");
  if (evidence.exactModeCurrentScd0Rows > 0)
    integrityFailures.push("current_scd0_labeled_exact");
  if (evidence.mixedLaneRows > 0)
    integrityFailures.push("lane_a_lane_b_pooling");
  if (evidence.hierarchyContextMissingRows > 0)
    integrityFailures.push("hierarchy_context_unreconstructable");
  if (evidence.actionCoverageUnknownRows > 0)
    integrityFailures.push("parent_action_coverage_unknown");
  if (evidence.oldTargetThirtyDayDriftRows > 0)
    integrityFailures.push("old_target_30d_decision_drift");
  if (evidence.namedAccountFailingStrata.length > 0)
    qualityFailures.push("named_account_quality_or_coverage_failed");
  if (options.consecutiveDailyCoverageComplete === false)
    qualityFailures.push("consecutive_daily_coverage_incomplete");
  if (options.lockedWindowExact === false)
    integrityFailures.push("locked_window_or_outcome_ceiling_mismatch");
  if (evidence.rawScaleDeltaRows > 0)
    integrityFailures.push("raw_scale_drift");
  if (evidence.rawRefreshDeltaRows > 0)
    integrityFailures.push("raw_refresh_drift");
  if (evidence.aboveBreakEvenCutRows > 0)
    integrityFailures.push("above_break_even_cut");
  if (evidence.physicalAccountAovChangedCutRows === 0)
    integrityFailures.push("d061_axis_not_exercised");
  if (locked.challenger.knownOpportunities < 100)
    qualityFailures.push("locked_known_outcomes_below_100");
  if (
    locked.challenger.precision === null ||
    locked.challenger.precision < 0.92
  ) {
    qualityFailures.push("locked_precision_below_0_92");
  }
  if (
    locked.challenger.opportunityRecall === null ||
    locked.challenger.opportunityRecall < 0.92
  ) {
    qualityFailures.push("locked_recall_below_0_92");
  }
  if (
    locked.challenger.precisionWilson95 === null ||
    locked.challenger.precisionWilson95.lower < 0.85
  ) {
    qualityFailures.push("locked_precision_wilson_lower_below_0_85");
  }
  if (
    locked.pairedOpportunityRecallDelta.lower95 === null ||
    locked.pairedOpportunityRecallDelta.lower95 <= -0.02
  ) {
    qualityFailures.push("paired_recall_noninferiority_not_met");
  }
  if (options.crossArtifactParityValid === false)
    integrityFailures.push("cross_artifact_parity_invalid");
  if (options.legacyTargetCorroborationValid === false)
    integrityFailures.push("legacy_target_corroboration_invalid");
  const integrityPassed = integrityFailures.length === 0;
  const historicalPromotionQualityPassed = qualityFailures.length === 0;
  const automationEligibleRows = rows.filter(sourceAuthorityEligible).length;
  const calibrationFailureSamples = expectedAccountStrata.flatMap((account) => {
    const failures = chronologicalIntegrityRows.filter(
      (row) =>
        row.providerAccountId === account.providerAccountId &&
        (!row.calibrationProof.exactCellMatched || row.executionError !== null),
    );
    const indexes = [0, Math.floor(failures.length / 2), failures.length - 1];
    return [...new Set(indexes)]
      .filter((index) => index >= 0 && index < failures.length)
      .map((index) => failures[index]!)
      .map((row) => ({
        rowHash: row.rowHash,
        businessName: row.businessName,
        providerAccountId: row.providerAccountId,
        asOfDate: row.asOfDate,
        sourceRestatementProof: row.sourceRestatementProof,
        calibrationProof: row.calibrationProof,
        accountAovProof: row.accountAovProof,
        executionError: row.executionError,
      }));
  });
  return {
    contractVersion: "adsecute.meta.d061-closed-window-gate.v3",
    classification: !integrityPassed
      ? "stop_and_fix"
      : historicalPromotionQualityPassed
        ? "retain_as_policy_contract_repair_review_only"
        : "review_only_reject_promotion",
    sourceAuthority: {
      laneA: {
        sourceModes: ["persisted_native_decision_input", "cutoff_safe_raw_pit"],
        automationEligibleRows,
        status:
          automationEligibleRows >= 100
            ? "promotion_evidence_available"
            : "insufficient_exact_or_persisted_evidence",
      },
      laneB: {
        sourceMode: "restated_ad_daily",
        reviewOnlyRows: rows.filter((row) => row.sourceModeRestated).length,
        mayOpenAutomation: false,
      },
    },
    fixedCohort: {
      rows: rows.length,
      uniqueRows,
      duplicateRows: rows.length - uniqueRows,
      fixedBeforeVariants: true,
      inputHash: d061StableHash(
        rows.map((row) => ({
          cohortKey: row.cohortKey,
          rowHash: row.rowHash,
        })),
      ),
    },
    evidence,
    strata,
    integrityGate: {
      passed: integrityPassed,
      exitCode: integrityPassed ? 0 : 1,
      required: {
        zeroConflictingDuplicateFactGroups: true,
        zeroExecutionErrors: true,
        uniqueChronologicalIntegrityPopulation: true,
        fixedCohortCoveredByChronologicalIntegrityPopulation: true,
        validExpectedAccountManifest: true,
        uniqueFixedCohort: true,
        zeroCutoffFallbackOrUnlabeledLookahead: true,
        zeroCurrentScd0LabeledExact: true,
        noLanePooling: true,
        completeHierarchyAndActionCoverage: true,
        zeroOldTargetThirtyDayDrift: true,
        exactLockedWindow: true,
        zeroScaleRefreshDrift: true,
        zeroAboveBreakEvenCut: true,
        d061AxisExercised: true,
        crossArtifactParityRequired: true,
        legacyTargetCorroborationMustMatch: true,
      },
      failures: integrityFailures,
    },
    historicalPromotionQualityGate: {
      passed: historicalPromotionQualityPassed,
      required: {
        minimumLockedKnownOutcomes: 100,
        minimumLockedPrecision: 0.92,
        minimumLockedRecall: 0.92,
        minimumLockedPrecisionWilsonLower95: 0.85,
        pairedRecallNoninferiorityMargin: -0.02,
        allNamedAccountsCovered: true,
        allNamedAccountsMeetQualityThresholds: true,
        minimumNamedAccountKnownOutcomes: 20,
        consecutiveDailyCoverageComplete: true,
        laneBOnly: true,
      },
      observed: {
        lockedKnownOutcomes: locked.challenger.knownOpportunities,
        lockedCompleteRows: locked.challenger.completeRows,
        lockedPrimaryRows: locked.challenger.primaryRows,
        lockedKnownEmitted: locked.challenger.knownEmitted,
        lockedSupported: locked.challenger.supported,
        lockedRefuted: locked.challenger.refuted,
        lockedOpportunityPositive: locked.challenger.opportunityPositive,
        lockedOpportunityCaptured: locked.challenger.opportunityCaptured,
        lockedPrecision: locked.challenger.precision,
        lockedPrecisionWilsonLower95:
          locked.challenger.precisionWilson95?.lower ?? null,
        lockedRecall: locked.challenger.opportunityRecall,
        pairedRecallLower95: locked.pairedOpportunityRecallDelta.lower95,
      },
      failures: qualityFailures,
    },
    automationPromotionGate: {
      passed: false,
      reason: rows.some((row) => row.sourceModeRestated)
        ? "restated_history_is_review_only"
        : "exact_or_persisted_d047_gate_not_met",
      statisticalThresholds: {
        minimumKnownOutcomes: 100,
        minimumPrecision: 0.92,
        minimumRecall: 0.92,
        minimumPrecisionWilsonLower95: 0.85,
        pairedRecallNoninferiorityMargin: -0.02,
        zeroSafetyViolations: true,
      },
    },
    changedDecisionRows: rows
      .filter(
        (row) =>
          row.baseline.preAuthorityLabel !== row.challenger.preAuthorityLabel ||
          row.baseline.finalLabel !== row.challenger.finalLabel,
      )
      .map((row) => ({
        rowHash: row.rowHash,
        businessName: row.businessName,
        providerAccountId: row.providerAccountId,
        adIdHash: row.adIdHash,
        asOfDate: row.asOfDate,
        sourceMode: row.sourceMode,
        targetEffectiveAt: row.target.effectiveAt,
        targetAgeDays: row.target.ageDays,
        preDecision: row.preDecision,
        accountAovProof: row.accountAovProof,
        baseline: row.baseline,
        challenger: row.challenger,
        outcomes: row.outcomes,
      })),
    calibrationFailureSamples,
    challengerRawCutRows: rows
      .filter((row) => row.challenger.rawLabel === "cut")
      .map((row) => ({
        rowHash: row.rowHash,
        businessName: row.businessName,
        providerAccountId: row.providerAccountId,
        adIdHash: row.adIdHash,
        asOfDate: row.asOfDate,
        target: row.target,
        preDecision: row.preDecision,
        calibrationProof: row.calibrationProof,
        accountAovProof: row.accountAovProof,
        challenger: row.challenger,
        outcomes: row.outcomes,
      })),
  };
}
