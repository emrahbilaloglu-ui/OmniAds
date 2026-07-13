import { describe, expect, it } from "vitest";

import {
  CONTROLLED_HYDRATION_VERSION,
  ControlledRegistrySchemaError,
} from "@/lib/meta/controlled-experiment-registry";
import {
  buildAdRecommendationEpisode,
  buildExactMetaAdsActionReceiptHash,
  type AdRecommendationEpisode,
  type ExactMetaAdsActionLineage,
} from "../../ad-operator-response-detection";
import { DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION } from "../../execution-safety";
import { NATIVE_AD_ENGINE_VERSION } from "../../types";
import {
  AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
  AD_DECISION_CONTROLLED_LINEAGE_VERSION,
  AD_DECISION_OUTCOME_CONTRACT_VERSION,
  AD_DECISION_OUTCOME_WINDOWS_DAYS,
  CREATE_AD_DECISION_OUTCOMES_TABLE_SQL,
  FINALIZE_AD_DECISION_OUTCOME_RUN_SQL,
  INSERT_AD_DECISION_OUTCOMES_SQL,
  READ_AD_DECISION_OUTCOME_SOURCE_ROWS_SQL,
  START_AD_DECISION_OUTCOME_RUN_SQL,
  accrueAdDecisionOutcomes,
  buildAdDecisionOutcomeRecord,
  executeAdDecisionOutcomesJob,
  inspectAdDecisionOutcomeSchemaCapability,
  runAdDecisionOutcomesJobForActiveBusinessesIfDue,
  type AdDecisionOutcomeQuery,
  type AdDecisionOutcomeSourceRow,
  type ControlledEvidenceReader,
} from "../../jobs/ad-decision-outcomes-job";
import type { DbClient } from "@/lib/db";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function accountReceipt(date: string) {
  const published = new Date(`${date}T00:00:00.000Z`);
  published.setUTCDate(published.getUTCDate() + 1);
  published.setUTCHours(4);
  return {
    date,
    pointerId: `pointer-${date}`,
    sliceVersionId: `slice-${date}`,
    manifestId: `manifest-${date}`,
    sourceRunId: `source-${date}`,
    state: "finalized_verified",
    truthState: "finalized",
    validationStatus: "passed",
    status: "published",
    publishedAt: published.toISOString(),
  };
}

function fact(input: {
  adId: string;
  date: string;
  spend: number;
  revenue: number;
  currency?: string;
}) {
  return {
    id: `fact-${input.adId}-${input.date}`,
    date: input.date,
    accountCurrency: input.currency ?? "USD",
    spend: input.spend,
    purchases: input.revenue > 0 ? 2 : 0,
    revenue: input.revenue,
    truthState: "finalized",
    truthVersion: 3,
    finalizedAt: `${input.date}T05:00:00.000Z`,
    validationStatus: "passed",
    sourceRunId: `source-${input.date}`,
    sourceSnapshotId: `snapshot-${input.date}`,
    metricSchemaVersion: 2,
    updatedAt: `${input.date}T05:00:00.000Z`,
  };
}

function sourceRow(
  overrides: Partial<AdDecisionOutcomeSourceRow> = {},
): AdDecisionOutcomeSourceRow {
  const adId = String(overrides.ad_id ?? "ad-1");
  return {
    total_candidate_count: 1,
    decision_snapshot_id: `decision-${adId}`,
    evaluation_id: `evaluation-${adId}`,
    source_decision_job_run_id: "source-decision-job-1",
    business_ref_id: "business-1",
    business_id: "business-1",
    provider_account_id: "account-1",
    provider_account_ref_id: "account-ref-1",
    decision_entity_type: "ad",
    decision_entity_id: adId,
    ad_id: adId,
    creative_id: "shared-creative",
    decision_as_of_date: "2026-07-01",
    evaluation_date: "2026-07-05",
    outcome_window_days: 3,
    outcome_window_start: "2026-07-02",
    outcome_window_end: "2026-07-04",
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: "account-1",
    label: "cut",
    raw_label: "cut",
    confidence: 80,
    effective_target_roas: 2,
    target_roas: 2,
    break_even_roas: 1,
    effective_cohort: "purchase",
    objective: "OUTCOME_SALES",
    optimization_goal: "OFFSITE_CONVERSIONS",
    custom_event_type: "PURCHASE",
    commercial_target_freshness_json: { status: "fresh" },
    baseline_spend: 30,
    baseline_purchases: 0,
    baseline_roas: 0,
    source_input_hash: HASH_A,
    source_decision_hash: HASH_B,
    decision_recommended_at: "2026-07-01T04:00:00.000Z",
    evaluation_contract_version: "engine-v3-ad-decision-evaluation.v1",
    campaign_context_json: { kind: "test", source: "system_inferred" },
    expected_day_count: 3,
    completed_day_count: 3,
    ad_publication_receipts_json: [
      accountReceipt("2026-07-02"),
      accountReceipt("2026-07-03"),
      accountReceipt("2026-07-04"),
    ],
    fact_rows_json: [
      fact({ adId, date: "2026-07-02", spend: 10, revenue: 0 }),
      fact({ adId, date: "2026-07-03", spend: 10, revenue: 0 }),
      fact({ adId, date: "2026-07-04", spend: 10, revenue: 0 }),
    ],
    fact_currency_count: 1,
    invalid_fact_count: 0,
    invalid_fact_receipts_json: [],
    candidate_action_receipts_json: [],
    state_receipts_json: [],
    ...overrides,
  };
}

function nativeActionReceipt(
  input: {
    episode?: Partial<Omit<AdRecommendationEpisode, "episodeKey">>;
    action?: Partial<ExactMetaAdsActionLineage>;
  } = {},
) {
  const episode = buildAdRecommendationEpisode({
    businessId: "business-1",
    businessDisplayId: "business-1",
    providerAccountRefId: "account-ref-1",
    providerAccountId: "account-1",
    adId: "ad-1",
    creativeId: "shared-creative",
    asOfDate: "2026-07-01",
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    scopeType: "account",
    scopeId: "account-1",
    snapshotId: "decision-ad-1",
    evaluationId: "evaluation-ad-1",
    inputHash: HASH_A,
    decisionHash: HASH_B,
    decisionLabel: "cut",
    sourceCampaignId: "campaign-1",
    sourceAdsetId: "adset-1",
    recommendedAt: "2026-07-01T04:00:00.000Z",
    ...input.episode,
  });
  const { receiptHash: requestedReceiptHash, ...actionOverrides } =
    input.action ?? {};
  const actionWithoutHash: Omit<ExactMetaAdsActionLineage, "receiptHash"> = {
    receiptId: "receipt-valid",
    actionLogId: "action-valid",
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: episode.businessId,
    providerAccountRefId: episode.providerAccountRefId,
    providerAccountId: episode.providerAccountId,
    sourceAdId: episode.adId,
    sourceSnapshotId: episode.snapshotId,
    sourceEvaluationId: episode.evaluationId,
    sourceEngineVersion: episode.engineVersion,
    sourceDecisionHash: episode.decisionHash,
    targetEntityType: "ad",
    targetEntityId: episode.adId,
    action: "pause",
    successorKind: null,
    resultingAdId: null,
    idempotencyKey: "decision-ad-action:ad-1:pause",
    status: "success",
    dryRun: false,
    providerVerified: true,
    requestedAt: "2026-07-01T05:00:00.000Z",
    verifiedAt: "2026-07-01T05:30:00.000Z",
    finalizedAt: "2026-07-01T06:00:00.000Z",
    capturedAt: "2026-07-01T06:05:00.000Z",
    verificationEntityId: episode.adId,
    verificationStatus: "PAUSED",
    ...actionOverrides,
  };
  return {
    ...actionWithoutHash,
    receiptHash:
      requestedReceiptHash ??
      buildExactMetaAdsActionReceiptHash(actionWithoutHash),
    episode,
  };
}

function build(row: AdDecisionOutcomeSourceRow) {
  return buildAdDecisionOutcomeRecord({
    source: row,
    jobRunId: "job-run-1",
    computedAt: "2026-07-05T04:00:00.000Z",
  });
}

describe("native ad decision outcome contract", () => {
  it("uses only native snapshots/evaluations and finalized exact-ad facts", () => {
    const sql = READ_AD_DECISION_OUTCOME_SOURCE_ROWS_SQL.toLowerCase();
    expect(sql).toContain(
      "from engine_v3_ad_decision_snapshots_daily snapshot",
    );
    expect(sql).toContain("engine_v3_ad_decision_evaluations evaluation");
    expect(sql).toContain("from meta_ad_daily fact");
    expect(sql).toContain(
      "fact.provider_account_id = candidate.provider_account_id",
    );
    expect(sql).toContain("fact.ad_id = candidate.ad_id");
    expect(sql).toContain("fact.truth_state = 'finalized'");
    expect(sql).toContain("fact.validation_status = 'passed'");
    expect(sql).toContain("fact.source_run_id = slice.source_run_id");
    expect(sql).toContain("snapshot.engine_version = $6::text");
    expect(sql).toContain(
      "evaluation.provider_account_ref_id = snapshot.provider_account_ref_id",
    );
    expect(sql).toContain("evaluation.job_run_id = snapshot.job_run_id");
    expect(sql).toContain("snapshot.scope_id = snapshot.provider_account_id");
    expect(sql).toContain(
      "snapshot.as_of_date + windows.outcome_window_days = ($2::date - 1)",
    );
    expect(sql).toContain("(fact.date + 1)::timestamp at time zone 'utc'");
    expect(sql).toContain("interval '5 hours'");
    expect(sql).toContain("count(*) over ()::integer as total_candidate_count");
    expect(sql).toContain("limit ($5::integer + 1)");
    expect(sql).toContain("meta_authoritative_publication_pointers");
    expect(sql).toContain("pointer.surface = 'ad_daily'");
    expect(sql).toContain("from engine_v3_ad_recommendation_episodes episode");
    expect(sql).toContain(
      "inner join engine_v3_ad_operator_action_receipts receipt",
    );
    expect(sql).not.toContain("from meta_ads_action_log");
    expect(sql).not.toContain("meta_creative_daily");
    expect(sql).not.toContain("meta_controlled_");
    expect(sql).not.toContain("engine_v3_decision_snapshots_daily");
    expect(sql).not.toContain("engine_v3_decision_outcomes_daily");
  });

  it("keeps two ads sharing one creative as independent outcomes", () => {
    const first = build(
      sourceRow({ ad_id: "ad-1", decision_entity_id: "ad-1" }),
    );
    const second = build(
      sourceRow({
        ad_id: "ad-2",
        decision_entity_id: "ad-2",
        fact_rows_json: [
          fact({ adId: "ad-2", date: "2026-07-02", spend: 10, revenue: 20 }),
          fact({ adId: "ad-2", date: "2026-07-03", spend: 10, revenue: 20 }),
          fact({ adId: "ad-2", date: "2026-07-04", spend: 10, revenue: 20 }),
        ],
      }),
    );

    expect(first.creative_id).toBe("shared-creative");
    expect(second.creative_id).toBe("shared-creative");
    expect(first.provider_account_ref_id).toBe("account-ref-1");
    expect(first.ad_id).toBe("ad-1");
    expect(second.ad_id).toBe("ad-2");
    expect(first.realized_outcome).toBe("positive");
    expect(second.realized_outcome).toBe("negative");
    expect(first.fact_source_hash).not.toBe(second.fact_source_hash);
  });

  it("marks a window unknown when any account receipt day is missing", () => {
    const outcome = build(
      sourceRow({
        ad_publication_receipts_json: [
          accountReceipt("2026-07-02"),
          accountReceipt("2026-07-04"),
        ],
        fact_rows_json: [
          fact({ adId: "ad-1", date: "2026-07-02", spend: 10, revenue: 0 }),
          fact({ adId: "ad-1", date: "2026-07-04", spend: 10, revenue: 0 }),
        ],
        completed_day_count: 2,
      }),
    );

    expect(outcome.expected_day_count).toBe(3);
    expect(outcome.completed_day_count).toBe(2);
    expect(outcome.window_complete).toBe(false);
    expect(outcome.measurement_status).toBe("unknown");
    expect(outcome.realized_outcome).toBe("unknown");
  });

  it("does not admit same-day evidence published after the 05:00 UTC cutoff", () => {
    const outcome = build(
      sourceRow({
        completed_day_count: 2,
        fact_rows_json: [
          fact({ adId: "ad-1", date: "2026-07-02", spend: 10, revenue: 0 }),
          fact({ adId: "ad-1", date: "2026-07-03", spend: 10, revenue: 0 }),
        ],
        ad_publication_receipts_json: [
          accountReceipt("2026-07-02"),
          accountReceipt("2026-07-03"),
          {
            ...accountReceipt("2026-07-04"),
            publishedAt: "2026-07-05T05:01:00.000Z",
          },
        ],
      }),
    );

    expect(outcome.window_complete).toBe(false);
    expect(outcome.measurement_status).toBe("unknown");
    expect(outcome.evidence_json).toMatchObject({
      rule: "missing_ad_daily_publication_receipts",
    });
  });

  it("does not close the window on its final calendar day", () => {
    expect(() =>
      build(
        sourceRow({
          evaluation_date: "2026-07-04",
        }),
      ),
    ).toThrow("Finalized ad fact lineage is duplicate or invalid");
  });

  it("rejects facts that do not belong to the published account slice", () => {
    const mismatched = fact({
      adId: "ad-1",
      date: "2026-07-02",
      spend: 10,
      revenue: 0,
    });
    mismatched.sourceRunId = "different-source-run";
    expect(() =>
      build(
        sourceRow({
          fact_rows_json: [mismatched],
        }),
      ),
    ).toThrow("Finalized ad fact lineage is duplicate or invalid");
  });

  it("rejects any non-current native engine epoch", () => {
    expect(() =>
      build(sourceRow({ engine_version: "stale-native-epoch" })),
    ).toThrow("engine epoch is not current");
  });

  it("distinguishes known zero ROAS from censored zero spend", () => {
    const zeroRoas = build(sourceRow());
    const zeroSpend = build(
      sourceRow({
        fact_rows_json: [],
        fact_currency_count: 0,
      }),
    );

    expect(zeroRoas.outcome_spend).toBe(30);
    expect(zeroRoas.outcome_revenue).toBe(0);
    expect(zeroRoas.outcome_roas).toBe(0);
    expect(zeroRoas.measurement_status).toBe("known");
    expect(zeroRoas.realized_outcome).toBe("positive");

    expect(zeroSpend.outcome_spend).toBe(0);
    expect(zeroSpend.outcome_roas).toBeNull();
    expect(zeroSpend.measurement_status).toBe("censored");
    expect(zeroSpend.realized_outcome).toBe("unknown");
  });

  it("does not reinterpret legacy metric-schema zeroes as observed revenue", () => {
    const legacyFacts = (
      sourceRow().fact_rows_json as Array<Record<string, unknown>>
    ).map((row) => ({ ...row, metricSchemaVersion: 1 }));
    const outcome = build(sourceRow({ fact_rows_json: legacyFacts }));

    expect(outcome.outcome_spend).toBe(30);
    expect(outcome.outcome_revenue).toBe(0);
    expect(outcome.measurement_status).toBe("unknown");
    expect(outcome.realized_outcome).toBe("unknown");
    expect(outcome.evidence_json).toMatchObject({
      rule: "metric_schema_unproven",
    });
  });

  it("does not turn a filtered invalid ad fact into apparent zero spend", () => {
    const outcome = build(
      sourceRow({
        fact_rows_json: [],
        fact_currency_count: 0,
        invalid_fact_count: 1,
        invalid_fact_receipts_json: [
          {
            id: "invalid-fact-1",
            date: "2026-07-02",
            truthState: "provisional",
            sourceRunId: "wrong-run",
          },
        ],
      }),
    );

    expect(outcome.outcome_spend).toBe(0);
    expect(outcome.measurement_status).toBe("unknown");
    expect(outcome.evidence_json).toMatchObject({
      rule: "ad_fact_lineage_invalid",
      invalidFactCount: 1,
    });
  });

  it("marks zero spend as explained only with an exact durable state receipt", () => {
    const outcome = build(
      sourceRow({
        fact_rows_json: [],
        fact_currency_count: 0,
        state_receipts_json: [
          {
            id: "state-paused",
            businessId: "business-1",
            providerAccountRefId: "account-ref-1",
            providerAccountId: "account-1",
            entityType: "ad",
            entityId: "ad-1",
            configuredStatus: "PAUSED",
            effectiveStatus: "PAUSED",
            presence: "present",
            observedAt: "2026-07-01T23:00:00.000Z",
            capturedAt: "2026-07-01T23:05:00.000Z",
            runCompleteness: "complete",
            stateHash: HASH_C,
          },
        ],
      }),
    );

    expect(outcome.measurement_status).toBe("explained_zero_spend");
    expect(outcome.realized_outcome).toBe("unknown");
    expect(outcome.action_contaminated).toBe(false);
  });

  it("accepts only typed provider-verified exact-ad actions as contamination", () => {
    const valid = nativeActionReceipt();
    const dryRun = nativeActionReceipt({
      action: {
        receiptId: "receipt-dry-run",
        actionLogId: "action-dry-run",
        dryRun: true,
        providerVerified: false,
        verifiedAt: null,
        verificationEntityId: null,
        verificationStatus: null,
      },
    });
    const failed = nativeActionReceipt({
      action: {
        receiptId: "receipt-failed",
        actionLogId: "action-failed",
        status: "failure",
        providerVerified: false,
        verifiedAt: null,
        verificationEntityId: null,
        verificationStatus: null,
      },
    });
    const tampered = {
      ...nativeActionReceipt({
        action: {
          receiptId: "receipt-tampered",
          actionLogId: "action-tampered",
        },
      }),
      receiptHash: HASH_A,
    };
    const sibling = nativeActionReceipt({
      episode: {
        adId: "ad-2",
        snapshotId: "decision-ad-2",
        evaluationId: "evaluation-ad-2",
      },
      action: {
        receiptId: "receipt-sibling",
        actionLogId: "action-sibling",
      },
    });
    const outcome = build(
      sourceRow({
        candidate_action_receipts_json: [
          valid,
          dryRun,
          failed,
          tampered,
          sibling,
        ],
      }),
    );
    const receipts = outcome.source_receipts_json.verifiedActions as Array<{
      id: string;
      receiptId: string;
      exactLineageValidated: boolean;
    }>;
    const nonTreatment = outcome.source_receipts_json
      .nonTreatmentActions as Array<{ id: string }>;

    expect(receipts.map((receipt) => receipt.id)).toEqual(["action-valid"]);
    expect(receipts[0]).toMatchObject({
      receiptId: "receipt-valid",
      exactLineageValidated: true,
    });
    expect(nonTreatment.map((receipt) => receipt.id)).toEqual([
      "action-dry-run",
      "action-failed",
    ]);
    expect(outcome.action_contaminated).toBe(true);
    expect(outcome.treatment_status).toBe("observational_action_exposed");
    expect(outcome.measurement_status).toBe("unknown");
    expect(outcome.evidence_json).toMatchObject({
      rule: "action_lineage_invalid",
      invalidActionCount: 2,
    });
  });

  it("rejects a native action receipt whose immutable receipt hash is stale", () => {
    const valid = nativeActionReceipt();
    const outcome = build(
      sourceRow({
        candidate_action_receipts_json: [
          {
            ...valid,
            finalizedAt: "2026-07-01T06:15:00.000Z",
            capturedAt: "2026-07-01T06:20:00.000Z",
          },
        ],
      }),
    );

    expect(outcome.source_receipts_json.verifiedActions).toEqual([]);
    expect(outcome.action_contaminated).toBe(true);
    expect(outcome.measurement_status).toBe("unknown");
    expect(outcome.evidence_json).toMatchObject({
      rule: "action_lineage_invalid",
      invalidActionCount: 1,
    });
  });

  it("does not admit an unverified successful receipt into the uncontaminated cohort", () => {
    const ambiguous = nativeActionReceipt({
      action: {
        providerVerified: false,
        verifiedAt: null,
        verificationEntityId: null,
        verificationStatus: null,
      },
    });
    const outcome = build(
      sourceRow({ candidate_action_receipts_json: [ambiguous] }),
    );

    expect(outcome.source_receipts_json.verifiedActions).toEqual([]);
    expect(outcome.source_receipts_json.nonTreatmentActions).toEqual([]);
    expect(
      outcome.source_receipts_json.ambiguousActions as unknown[],
    ).toHaveLength(1);
    expect(outcome.action_contaminated).toBe(true);
    expect(outcome.treatment_status).toBe("observational_action_exposed");
    expect(outcome.measurement_status).toBe("unknown");
    expect(outcome.evidence_json).toMatchObject({
      rule: "action_treatment_state_unresolved",
      ambiguousActionCount: 1,
    });
  });

  it("requires exact native assignment, receipt hash, and chronology for controlled treatment", async () => {
    const businessId = "11111111-1111-4111-8111-111111111111";
    const providerAccountRefId = "22222222-2222-4222-8222-222222222222";
    const snapshotId = "33333333-3333-4333-8333-333333333333";
    const evaluationId = "44444444-4444-4444-8444-444444444444";
    const actionLogId = "55555555-5555-4555-8555-555555555555";
    const outcomeLogId = "66666666-6666-4666-8666-666666666666";
    const assignmentId = "assignment-native-1";
    const controlledAction = nativeActionReceipt({
      episode: {
        businessId,
        businessDisplayId: businessId,
        providerAccountRefId,
        snapshotId,
        evaluationId,
      },
      action: {
        receiptId: "77777777-7777-4777-8777-777777777777",
        actionLogId,
        idempotencyKey: "native-controlled-action-1",
      },
    });
    const source = sourceRow({
      decision_snapshot_id: snapshotId,
      evaluation_id: evaluationId,
      business_ref_id: businessId,
      business_id: businessId,
      provider_account_ref_id: providerAccountRefId,
      candidate_action_receipts_json: [controlledAction],
    });
    const controlledRow = {
      contractVersion: CONTROLLED_HYDRATION_VERSION,
      outcomeLogId,
      businessId,
      providerAccountId: "account-1",
      recommendationFingerprint: "fingerprint-1",
      recId: "rec-native-1",
      recType: "engine_v3_ad_decision",
      decisionLabel: "cut",
      actionType: "outcome",
      outcomeStatus: "positive",
      occurredAt: "2026-07-05T01:00:00.000Z",
      causalAssignmentValidated: true,
      treatmentReceiptValidated: true,
      causalEstimateValidated: true,
      controlledEvidenceValidated: true,
      invalidReasonCodes: [],
      evidence: {
        experimentId: "experiment-1",
        batchId: "batch-1",
        assignmentId,
        estimateId: "estimate-1",
        actionLogId,
        estimateFinalizedAt: "2026-07-05T02:00:00.000Z",
      },
      payloadJson: {
        nativeAdDecisionLineage: {
          contractVersion: AD_DECISION_CONTROLLED_LINEAGE_VERSION,
          snapshotId,
          evaluationId,
          businessId,
          providerAccountRefId,
          providerAccountId: "account-1",
          actionLogId,
          controlledAssignmentId: assignmentId,
          recId: "rec-native-1",
          entityType: "ad",
          adId: "ad-1",
          outcomeWindowStart: "2026-07-02",
          outcomeWindowEnd: "2026-07-04",
        },
      },
    };

    async function runControlled(
      jobRunId: string,
      row: Record<string, unknown>,
    ) {
      let payload: Record<string, unknown> | null = null;
      const query: AdDecisionOutcomeQuery = async <
        Row extends Record<string, unknown>,
      >(
        queryText: string,
        params?: readonly unknown[],
      ): Promise<Row[]> => {
        if (queryText === READ_AD_DECISION_OUTCOME_SOURCE_ROWS_SQL) {
          return [source] as unknown as Row[];
        }
        if (queryText === START_AD_DECISION_OUTCOME_RUN_SQL) {
          return [
            {
              id: `outcome-run-${jobRunId}`,
              job_run_id: jobRunId,
              business_ref_id: businessId,
              evaluation_date: "2026-07-05",
              engine_version: NATIVE_AD_ENGINE_VERSION,
              contract_version: AD_DECISION_OUTCOME_CONTRACT_VERSION,
              classifier_version: AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
              windows_days: [3],
              lookback_days: 120,
              candidate_row_count: 1,
              persisted_row_count: null,
              source_set_hash: params?.[10],
              status: "pending",
            },
          ] as unknown as Row[];
        }
        if (queryText === INSERT_AD_DECISION_OUTCOMES_SQL) {
          payload =
            (JSON.parse(String(params?.[0])) as Record<string, unknown>[])[0] ??
            null;
          return [
            {
              id: `outcome-${jobRunId}`,
              outcome_run_id: `outcome-run-${jobRunId}`,
              decision_snapshot_id: snapshotId,
              evaluation_id: evaluationId,
              source_set_hash: payload?.source_set_hash,
              source_manifest_hash: payload?.source_manifest_hash,
              inserted: true,
            },
          ] as unknown as Row[];
        }
        if (queryText === FINALIZE_AD_DECISION_OUTCOME_RUN_SQL) {
          return [
            {
              id: `outcome-run-${jobRunId}`,
              status: "complete",
              candidate_row_count: 1,
              persisted_row_count: 1,
              source_set_hash: params?.[7],
              published_window_count: 1,
            },
          ] as unknown as Row[];
        }
        throw new Error("Unexpected controlled outcome query");
      };
      await accrueAdDecisionOutcomes(
        {
          businessId,
          evaluationDate: "2026-07-05",
          jobRunId,
          windowsDays: [3],
        },
        {
          query,
          runInTransaction: async <T>(fn: () => Promise<T>) => fn(),
          readControlledEvidence: async () => [row],
          now: () => new Date("2026-07-05T04:00:00.000Z"),
        },
      );
      return payload;
    }

    const valid = await runControlled("job-valid", controlledRow);
    const tampered = await runControlled("job-tampered", {
      ...controlledRow,
      evidence: { ...controlledRow.evidence, assignmentId: "other-assignment" },
    });
    const lateBackfill = await runControlled("job-late", {
      ...controlledRow,
      evidence: {
        ...controlledRow.evidence,
        estimateFinalizedAt: "2026-07-05T05:01:00.000Z",
      },
    });
    const invalidClaim = await runControlled("job-invalid-claim", {
      ...controlledRow,
      invalidReasonCodes: ["receipt_reused"],
    });

    expect(valid).toMatchObject({
      treatment_status: "controlled_treatment",
      controlled_evidence_validated: true,
      action_contaminated: true,
    });
    expect(tampered).toMatchObject({
      treatment_status: "observational_action_exposed",
      controlled_evidence_validated: false,
      action_contaminated: true,
    });
    expect(lateBackfill).toMatchObject({
      treatment_status: "observational_action_exposed",
      controlled_evidence_validated: false,
    });
    expect(invalidClaim).toMatchObject({
      treatment_status: "observational_action_exposed",
      controlled_evidence_validated: false,
    });
  });

  it("keeps currency conflicts non-poolable and non-known", () => {
    const outcome = build(
      sourceRow({
        fact_rows_json: [
          fact({ adId: "ad-1", date: "2026-07-02", spend: 10, revenue: 0 }),
          fact({
            adId: "ad-1",
            date: "2026-07-03",
            spend: 10,
            revenue: 0,
            currency: "EUR",
          }),
        ],
        fact_currency_count: 2,
      }),
    );

    expect(outcome.currency_status).toBe("conflict");
    expect(outcome.account_currency).toBeNull();
    expect(outcome.measurement_status).toBe("unknown");
  });

  it("defines 3d, 7d, and 14d immutable versioned storage", () => {
    expect(AD_DECISION_OUTCOME_WINDOWS_DAYS).toEqual([3, 7, 14]);
    expect(CREATE_AD_DECISION_OUTCOMES_TABLE_SQL).toContain(
      "engine_v3_ad_outcomes_run_episode_unique",
    );
    expect(CREATE_AD_DECISION_OUTCOMES_TABLE_SQL).toContain(
      "engine_v3_ad_decision_outcome_runs",
    );
    expect(CREATE_AD_DECISION_OUTCOMES_TABLE_SQL).toContain(
      "engine_v3_ad_decision_outcome_publications",
    );
    expect(CREATE_AD_DECISION_OUTCOMES_TABLE_SQL).toContain(
      "engine_v3_ad_outcomes_account_binding_fk",
    );
    expect(CREATE_AD_DECISION_OUTCOMES_TABLE_SQL).toContain(
      "source_decision_job_run_id",
    );
    expect(INSERT_AD_DECISION_OUTCOMES_SQL).toContain(
      "account_binding.provider_account_ref_id = payload.provider_account_ref_id",
    );
    expect(CREATE_AD_DECISION_OUTCOMES_TABLE_SQL).toContain(
      "BEFORE UPDATE OR DELETE",
    );
    expect(INSERT_AD_DECISION_OUTCOMES_SQL).toContain(
      "ON CONFLICT ON CONSTRAINT engine_v3_ad_outcomes_run_episode_unique",
    );
    expect(INSERT_AD_DECISION_OUTCOMES_SQL).toContain("DO NOTHING");
    expect(INSERT_AD_DECISION_OUTCOMES_SQL).not.toContain("DO UPDATE");
    expect(FINALIZE_AD_DECISION_OUTCOME_RUN_SQL).toContain(
      "active_outcome_run_id",
    );
    expect(FINALIZE_AD_DECISION_OUTCOME_RUN_SQL).toContain(
      "persisted.persisted_row_count = run.candidate_row_count",
    );
  });

  it("keeps the runtime schema gate closed without run, pointer, and immutable receipt proof", async () => {
    const db = {
      query: async () => [],
    } as unknown as DbClient;
    const capability = await inspectAdDecisionOutcomeSchemaCapability(db);

    expect(capability.ready).toBe(false);
    expect(capability.missing).toContain(
      "engine_v3_ad_decision_outcomes_daily.outcome_run_id",
    );
    expect(capability.missing).toContain(
      "engine_v3_ad_operator_action_receipts.engine_v3_ad_operator_action_receipts_immutable",
    );
    expect(capability.missing).toContain(
      "engine_v3_ad_operator_action_receipts.receipt_hash_unique_index",
    );
  });

  it("rejects a correctly named action trigger with the wrong definition", async () => {
    const db = {
      query: async (queryText: string) =>
        queryText.includes("FROM pg_trigger")
          ? [
              {
                table_name: "engine_v3_ad_operator_action_receipts",
                trigger_name: "engine_v3_ad_operator_action_receipts_immutable",
                trigger_definition:
                  "CREATE TRIGGER engine_v3_ad_operator_action_receipts_immutable AFTER INSERT ON engine_v3_ad_operator_action_receipts FOR EACH ROW EXECUTE FUNCTION noop()",
              },
            ]
          : [],
    } as unknown as DbClient;
    const capability = await inspectAdDecisionOutcomeSchemaCapability(db);

    expect(capability.missing).toContain(
      "engine_v3_ad_operator_action_receipts.engine_v3_ad_operator_action_receipts_immutable.definition",
    );
  });

  it("rejects a correctly named native receipt immutability function that is a no-op", async () => {
    const db = {
      query: async (queryText: string) =>
        queryText.includes("FROM pg_proc")
          ? [
              {
                function_name:
                  "reject_engine_v3_ad_operator_action_receipt_mutation",
                function_definition:
                  "CREATE FUNCTION reject_engine_v3_ad_operator_action_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
              },
            ]
          : [],
    } as unknown as DbClient;
    const capability = await inspectAdDecisionOutcomeSchemaCapability(db);

    expect(capability.missing).toContain(
      "function.reject_engine_v3_ad_operator_action_receipt_mutation.definition",
    );
  });

  it("fails closed instead of publishing a batch-limited source subset", async () => {
    const query: AdDecisionOutcomeQuery = async <
      Row extends Record<string, unknown>,
    >(): Promise<Row[]> =>
      [sourceRow({ total_candidate_count: 2 })] as unknown as Row[];

    await expect(
      accrueAdDecisionOutcomes(
        {
          businessId: "business-1",
          evaluationDate: "2026-07-05",
          jobRunId: "job-run-1",
          batchLimit: 1,
        },
        {
          query,
          runInTransaction: async <T>(fn: () => Promise<T>) => fn(),
        },
      ),
    ).rejects.toThrow("source set is incomplete");
  });

  it("publishes an explicit complete zero-row generation so stale rows cannot remain active", async () => {
    const queries: string[] = [];
    const query: AdDecisionOutcomeQuery = async <
      Row extends Record<string, unknown>,
    >(
      queryText: string,
      params?: readonly unknown[],
    ): Promise<Row[]> => {
      queries.push(queryText);
      if (queryText === READ_AD_DECISION_OUTCOME_SOURCE_ROWS_SQL) return [];
      if (queryText === START_AD_DECISION_OUTCOME_RUN_SQL) {
        return [
          {
            id: "zero-run",
            job_run_id: "zero-job",
            business_ref_id: "business-1",
            evaluation_date: "2026-07-05",
            engine_version: NATIVE_AD_ENGINE_VERSION,
            contract_version: AD_DECISION_OUTCOME_CONTRACT_VERSION,
            classifier_version: AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
            windows_days: [3, 7, 14],
            lookback_days: 120,
            candidate_row_count: 0,
            persisted_row_count: null,
            source_set_hash: params?.[10],
            status: "pending",
          },
        ] as unknown as Row[];
      }
      if (queryText === FINALIZE_AD_DECISION_OUTCOME_RUN_SQL) {
        return [
          {
            id: "zero-run",
            status: "complete",
            candidate_row_count: 0,
            persisted_row_count: 0,
            source_set_hash: params?.[7],
            published_window_count: 3,
          },
        ] as unknown as Row[];
      }
      throw new Error("Unexpected zero-generation query");
    };

    const result = await accrueAdDecisionOutcomes(
      {
        businessId: "business-1",
        evaluationDate: "2026-07-05",
        jobRunId: "zero-job",
      },
      {
        query,
        runInTransaction: async <T>(fn: () => Promise<T>) => fn(),
      },
    );

    expect(result).toMatchObject({
      sourceRowCount: 0,
      outcomeRowCount: 0,
      publishedWindowCount: 3,
      outcomeRunId: "zero-run",
    });
    expect(queries).not.toContain(INSERT_AD_DECISION_OUTCOMES_SQL);
    expect(result.sourceSetHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not allow a custom persistence seam without a transaction", async () => {
    const query: AdDecisionOutcomeQuery = async () => [];
    await expect(
      accrueAdDecisionOutcomes(
        {
          businessId: "business-1",
          evaluationDate: "2026-07-05",
          jobRunId: "job-run-1",
        },
        { query },
      ),
    ).rejects.toThrow("requires an explicit transaction wrapper");
  });

  it("rejects a lookback that cannot contain the requested due window", async () => {
    await expect(
      accrueAdDecisionOutcomes(
        {
          businessId: "business-1",
          evaluationDate: "2026-07-16",
          jobRunId: "job-run-1",
          windowsDays: [14],
          lookbackDays: 14,
        },
        {
          query: async () => [],
          runInTransaction: async <T>(fn: () => Promise<T>) => fn(),
        },
      ),
    ).rejects.toThrow("lookback must be at least 15 days");
  });

  it("schedules each current business once with the exact 3d, 7d, and 14d windows", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await runAdDecisionOutcomesJobForActiveBusinessesIfDue(
      new Date("2026-07-12T04:20:00.000Z"),
      [{ id: "business-1", name: "Business One" }],
      {
        jobsDisabled: () => false,
        inspectSchema: async () => ({ ready: true, missing: [] }),
        readCompletedBusinessIds: async () => [],
        runJob: async (input) => {
          calls.push({ ...input, windowsDays: [...(input.windowsDays ?? [])] });
          return {
            jobRunId: "job-run-due",
            status: "success",
            engineVersion: NATIVE_AD_ENGINE_VERSION,
            sourceRowCount: 3,
            outcomeRowCount: 3,
            insertedRowCount: 3,
            publishedWindowCount: 3,
            controlledRegistryAvailable: true,
            sourceSetHash: HASH_A,
            durationMs: 10,
          };
        },
      },
    );

    expect(calls).toEqual([
      {
        businessId: "business-1",
        asOf: "2026-07-12",
        windowsDays: [3, 7, 14],
      },
    ]);
    expect(result).toMatchObject({
      skipped: false,
      asOf: "2026-07-12",
      results: [
        {
          businessId: "business-1",
          businessName: "Business One",
          status: "success",
          publishedWindowCount: 3,
        },
      ],
    });

    const alreadyRan = await runAdDecisionOutcomesJobForActiveBusinessesIfDue(
      new Date("2026-07-12T04:40:00.000Z"),
      [{ id: "business-1", name: "Business One" }],
      {
        jobsDisabled: () => false,
        inspectSchema: async () => ({ ready: true, missing: [] }),
        readCompletedBusinessIds: async () => ["business-1"],
        runJob: async () => {
          throw new Error("completed business must not run twice");
        },
      },
    );
    expect(alreadyRan).toEqual({
      skipped: true,
      reason: "already_ran",
      asOf: "2026-07-12",
    });
  });

  it("runs the scheduler-callable native job under lock, job-run, savepoint, and atomic publication", async () => {
    const source = sourceRow();
    const queries: string[] = [];
    const db = {
      query: async <Row extends Record<string, unknown>>(
        queryText: string,
        params?: unknown[],
      ): Promise<Row[]> => {
        queries.push(queryText);
        if (queryText.includes("pg_try_advisory_xact_lock")) {
          return [{ acquired: true }] as unknown as Row[];
        }
        if (queryText.includes("INSERT INTO engine_v3_job_runs")) {
          return [{ id: "job-run-1" }] as unknown as Row[];
        }
        if (queryText.startsWith("SAVEPOINT")) return [];
        if (queryText === READ_AD_DECISION_OUTCOME_SOURCE_ROWS_SQL) {
          return [source] as unknown as Row[];
        }
        if (queryText === START_AD_DECISION_OUTCOME_RUN_SQL) {
          return [
            {
              id: "outcome-run-1",
              job_run_id: "job-run-1",
              business_ref_id: "business-1",
              evaluation_date: "2026-07-05",
              engine_version: NATIVE_AD_ENGINE_VERSION,
              contract_version: AD_DECISION_OUTCOME_CONTRACT_VERSION,
              classifier_version: AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
              windows_days: [3, 7, 14],
              lookback_days: 120,
              candidate_row_count: 1,
              persisted_row_count: null,
              source_set_hash: params?.[10],
              status: "pending",
            },
          ] as unknown as Row[];
        }
        if (queryText === INSERT_AD_DECISION_OUTCOMES_SQL) {
          const payload = JSON.parse(String(params?.[0])) as Array<
            Record<string, unknown>
          >;
          return [
            {
              id: "outcome-1",
              outcome_run_id: "outcome-run-1",
              decision_snapshot_id: source.decision_snapshot_id,
              evaluation_id: source.evaluation_id,
              source_set_hash: payload[0]?.source_set_hash,
              source_manifest_hash: payload[0]?.source_manifest_hash,
              inserted: true,
            },
          ] as unknown as Row[];
        }
        if (queryText === FINALIZE_AD_DECISION_OUTCOME_RUN_SQL) {
          return [
            {
              id: "outcome-run-1",
              status: "complete",
              candidate_row_count: 1,
              persisted_row_count: 1,
              source_set_hash: params?.[7],
              published_window_count: 3,
            },
          ] as unknown as Row[];
        }
        if (
          queryText.includes("UPDATE engine_v3_job_runs") &&
          queryText.includes("status = 'success'")
        ) {
          return [{ id: "job-run-1" }] as unknown as Row[];
        }
        throw new Error(`Unexpected job query: ${queryText}`);
      },
    } as unknown as DbClient;

    const result = await executeAdDecisionOutcomesJob(
      { businessId: "business-1", asOf: "2026-07-05" },
      db,
      Date.now(),
      {
        inspectSchema: async () => ({ ready: true, missing: [] }),
        readControlledEvidence: async () => {
          throw new ControlledRegistrySchemaError({
            ready: false,
            issues: ["schema pending"],
          });
        },
        now: () => new Date("2026-07-05T04:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      jobRunId: "job-run-1",
      status: "success",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      sourceRowCount: 1,
      outcomeRowCount: 1,
      publishedWindowCount: 3,
    });
    expect(queries).toContain(
      "SAVEPOINT engine_v3_ad_decision_outcomes_job_work",
    );
    expect(
      queries.some((query) => query.includes("INSERT INTO engine_v3_job_runs")),
    ).toBe(true);
    expect(queries.some((query) => query.includes("status = 'success'"))).toBe(
      true,
    );
  });

  it("records lock contention as a skipped job run without entering the work savepoint", async () => {
    const queries: string[] = [];
    const db = {
      query: async <Row extends Record<string, unknown>>(
        queryText: string,
      ): Promise<Row[]> => {
        queries.push(queryText);
        if (queryText.includes("pg_try_advisory_xact_lock")) {
          return [{ acquired: false }] as unknown as Row[];
        }
        if (queryText.includes("INSERT INTO engine_v3_job_runs")) {
          return [{ id: "job-run-lock" }] as unknown as Row[];
        }
        throw new Error("Unexpected lock-contention query");
      },
    } as unknown as DbClient;

    const result = await executeAdDecisionOutcomesJob(
      { businessId: "business-1", asOf: "2026-07-05" },
      db,
    );

    expect(result).toMatchObject({
      status: "skipped",
      reason: "lock_not_acquired",
      jobRunId: "job-run-lock",
    });
    expect(queries.some((query) => query.startsWith("SAVEPOINT"))).toBe(false);
  });

  it("records schema-not-ready as skipped instead of a successful empty run", async () => {
    const queries: string[] = [];
    const db = {
      query: async <Row extends Record<string, unknown>>(
        queryText: string,
      ): Promise<Row[]> => {
        queries.push(queryText);
        if (queryText.includes("pg_try_advisory_xact_lock")) {
          return [{ acquired: true }] as unknown as Row[];
        }
        if (queryText.includes("INSERT INTO engine_v3_job_runs")) {
          return [{ id: "job-run-schema" }] as unknown as Row[];
        }
        if (
          queryText.includes("UPDATE engine_v3_job_runs") &&
          queryText.includes("status = 'skipped'")
        ) {
          return [{ id: "job-run-schema" }] as unknown as Row[];
        }
        return [];
      },
    } as unknown as DbClient;
    const result = await executeAdDecisionOutcomesJob(
      { businessId: "business-1", asOf: "2026-07-05" },
      db,
      Date.now(),
      {
        inspectSchema: async () => ({
          ready: false,
          missing: ["engine_v3_ad_decision_outcome_runs.id"],
        }),
      },
    );

    expect(result).toMatchObject({
      status: "skipped",
      reason: "schema_not_ready",
      jobRunId: "job-run-schema",
    });
    expect(queries.some((query) => query.includes("status = 'skipped'"))).toBe(
      true,
    );
    expect(queries).not.toContain(READ_AD_DECISION_OUTCOME_SOURCE_ROWS_SQL);
  });

  it("fails the transaction when a terminal job-run transition is not persisted", async () => {
    const db = {
      query: async <Row extends Record<string, unknown>>(
        queryText: string,
      ): Promise<Row[]> => {
        if (queryText.includes("pg_try_advisory_xact_lock")) {
          return [{ acquired: true }] as unknown as Row[];
        }
        if (queryText.includes("INSERT INTO engine_v3_job_runs")) {
          return [{ id: "job-run-terminal-drift" }] as unknown as Row[];
        }
        return [];
      },
    } as unknown as DbClient;

    await expect(
      executeAdDecisionOutcomesJob(
        { businessId: "business-1", asOf: "2026-07-05" },
        db,
        Date.now(),
        {
          inspectSchema: async () => ({
            ready: false,
            missing: ["engine_v3_ad_decision_outcome_runs.id"],
          }),
        },
      ),
    ).rejects.toThrow("failed transition was rejected");
  });

  it("rolls back the work savepoint and marks the job failed on an incomplete source set", async () => {
    const queries: string[] = [];
    const db = {
      query: async <Row extends Record<string, unknown>>(
        queryText: string,
      ): Promise<Row[]> => {
        queries.push(queryText);
        if (queryText.includes("pg_try_advisory_xact_lock")) {
          return [{ acquired: true }] as unknown as Row[];
        }
        if (queryText.includes("INSERT INTO engine_v3_job_runs")) {
          return [{ id: "job-run-failed" }] as unknown as Row[];
        }
        if (queryText === READ_AD_DECISION_OUTCOME_SOURCE_ROWS_SQL) {
          return [sourceRow({ total_candidate_count: 2 })] as unknown as Row[];
        }
        if (
          queryText.includes("UPDATE engine_v3_job_runs") &&
          queryText.includes("status = 'failed'")
        ) {
          return [{ id: "job-run-failed" }] as unknown as Row[];
        }
        return [];
      },
    } as unknown as DbClient;

    const result = await executeAdDecisionOutcomesJob(
      { businessId: "business-1", asOf: "2026-07-05" },
      db,
      Date.now(),
      { inspectSchema: async () => ({ ready: true, missing: [] }) },
    );

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("source set is incomplete");
    expect(queries).toContain(
      "ROLLBACK TO SAVEPOINT engine_v3_ad_decision_outcomes_job_work",
    );
    expect(queries.some((query) => query.includes("status = 'failed'"))).toBe(
      true,
    );
  });

  it("reruns idempotently while controlled schema absence stays non-fatal", async () => {
    let insertCount = 0;
    let transactionCount = 0;
    let runComplete = false;
    const source = sourceRow();
    const payloads: Array<Record<string, unknown>> = [];
    const query: AdDecisionOutcomeQuery = async <
      Row extends Record<string, unknown>,
    >(
      queryText: string,
      params?: readonly unknown[],
    ): Promise<Row[]> => {
      if (queryText === READ_AD_DECISION_OUTCOME_SOURCE_ROWS_SQL) {
        return [source] as unknown as Row[];
      }
      if (queryText === START_AD_DECISION_OUTCOME_RUN_SQL) {
        return [
          {
            id: "outcome-run-1",
            job_run_id: "job-run-1",
            business_ref_id: "business-1",
            evaluation_date: "2026-07-05",
            engine_version: NATIVE_AD_ENGINE_VERSION,
            contract_version: AD_DECISION_OUTCOME_CONTRACT_VERSION,
            classifier_version: AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
            windows_days: [3, 7, 14],
            lookback_days: 120,
            candidate_row_count: 1,
            persisted_row_count: runComplete ? 1 : null,
            source_set_hash: params?.[10],
            status: runComplete ? "complete" : "pending",
          },
        ] as unknown as Row[];
      }
      if (queryText === INSERT_AD_DECISION_OUTCOMES_SQL) {
        insertCount += 1;
        const payload = JSON.parse(String(params?.[0])) as Array<
          Record<string, unknown>
        >;
        payloads.push(payload[0] ?? {});
        return [
          {
            id: "outcome-1",
            outcome_run_id: "outcome-run-1",
            decision_snapshot_id: source.decision_snapshot_id,
            evaluation_id: source.evaluation_id,
            source_set_hash: payload[0]?.source_set_hash,
            source_manifest_hash: payload[0]?.source_manifest_hash ?? HASH_C,
            inserted: insertCount === 1,
          },
        ] as unknown as Row[];
      }
      if (queryText === FINALIZE_AD_DECISION_OUTCOME_RUN_SQL) {
        runComplete = true;
        return [
          {
            id: "outcome-run-1",
            status: "complete",
            candidate_row_count: 1,
            persisted_row_count: 1,
            source_set_hash: params?.[7],
            published_window_count: 3,
          },
        ] as unknown as Row[];
      }
      throw new Error("Unexpected native outcome query");
    };
    const readControlledEvidence: ControlledEvidenceReader = async () => {
      throw new ControlledRegistrySchemaError({
        ready: false,
        issues: ["schema pending"],
      });
    };
    const options = {
      query,
      runInTransaction: async <T>(fn: () => Promise<T>) => {
        transactionCount += 1;
        return fn();
      },
      readControlledEvidence,
      now: () => new Date("2026-07-05T04:00:00.000Z"),
    };
    const input = {
      businessId: "business-1",
      evaluationDate: "2026-07-05",
      jobRunId: "job-run-1",
    };

    const first = await accrueAdDecisionOutcomes(input, options);
    const second = await accrueAdDecisionOutcomes(input, options);

    expect(first.insertedRowCount).toBe(1);
    expect(second.insertedRowCount).toBe(0);
    expect(first.outcomes[0]?.id).toBe("outcome-1");
    expect(second.outcomes[0]?.id).toBe("outcome-1");
    expect(payloads[0]?.source_manifest_hash).toBe(
      payloads[1]?.source_manifest_hash,
    );
    expect(payloads[0]?.controlled_registry_available).toBe(false);
    expect(payloads[0]?.controlled_evidence_validated).toBe(false);
    expect(first.publishedWindowCount).toBe(3);
    expect(first.sourceSetHash).toBe(second.sourceSetHash);
    expect(transactionCount).toBe(2);
  });
});
