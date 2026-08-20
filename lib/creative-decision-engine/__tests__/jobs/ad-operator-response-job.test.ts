import { describe, expect, it } from "vitest";

import type { DbClient } from "@/lib/db";
import { LOCK_DECISION_ORIGIN_ACTION_FOR_FINALIZATION_QUERY } from "@/lib/meta/ads-action-log";
import {
  CANONICAL_EVALUATION_CONTRACT_VERSION,
  canonicalSha256,
} from "../../canonical-evaluation";
import {
  NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
  buildAdRecommendationEpisode,
  buildExactMetaAdsActionReceiptHash,
  detectAdOperatorResponse,
  type ExactMetaAdsActionLineage,
} from "../../ad-operator-response-detection";
import {
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  createDecisionOriginAdActionIdempotencyKey,
} from "../../execution-safety";
import { AD_DECISION_EVALUATION_CONTRACT_VERSION } from "../../evaluation-store";
import { NATIVE_AD_CALIBRATION_CONTRACT_VERSION } from "../../jobs/ad-calibration-job";
import {
  AD_OPERATOR_RESPONSE_EVENTS_TABLE,
  AD_OPERATOR_RESPONSE_SCHEMA_SQL,
  AD_OPERATOR_RESPONSES_TABLE,
  AD_OPERATOR_ACTION_RECEIPTS_TABLE,
  AD_RECOMMENDATION_EPISODES_TABLE,
  FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY,
  FIND_EXACT_NATIVE_AD_ACTION_RECEIPTS_QUERY,
  FIND_NATIVE_AD_RECOMMENDATION_EPISODE_CANDIDATES_QUERY,
  INSERT_AD_RECOMMENDATION_EPISODES_QUERY,
  INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY,
  READ_AD_OPERATOR_RESPONSES_QUERY,
  REPLACE_AD_OPERATOR_RESPONSE_BATCHES_QUERY,
  assertAdRecommendationEpisodeCapture,
  buildAdOperatorResponsePersistenceBatch,
  executeAdOperatorResponseJob,
  inspectAdOperatorResponseSchemaCapability,
  persistAdOperatorResponseBatches,
  persistAdRecommendationEpisodes,
  persistImmutableAdOperatorActionReceipt,
  readAdOperatorResponses,
  NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION,
  type AdOperatorResponsePersistenceBatch,
} from "../../jobs/ad-operator-response-job";
import { ENGINE_VERSION, NATIVE_AD_ENGINE_VERSION } from "../../types";

const CUTOFF = "2026-07-13T03:00:00.000Z";
const JOB_RUN_ID = "00000000-0000-4000-8000-000000000099";

describe("decision-presentation hardening release epoch contract", () => {
  it("locks current contracts and the exact immediately previous rollback epoch", () => {
    expect(ENGINE_VERSION).toBe(
      "v3-2026-07-18-decision-presentation-hardening",
    );
    expect(NATIVE_AD_ENGINE_VERSION).toBe(
      "v3-ad-2026-07-18-decision-presentation-hardening-shadow",
    );
    expect(NATIVE_AD_CALIBRATION_CONTRACT_VERSION).toBe(
      "engine-v3-native-ad-calibration.v3",
    );
    expect(CANONICAL_EVALUATION_CONTRACT_VERSION).toBe(
      "engine-v3-canonical-evaluation.v5",
    );
    expect(AD_DECISION_EVALUATION_CONTRACT_VERSION).toBe(
      "engine-v3-canonical-ad-evaluation.v7",
    );
    expect(NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION).toBe(
      "v3-ad-2026-07-15-commercial-stop-loss-shadow",
    );
    expect(NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION).not.toBe(
      NATIVE_AD_ENGINE_VERSION,
    );
  });
});

function dbClient(
  query: (queryText: string, params?: unknown[]) => Promise<unknown[]>,
): DbClient {
  const callable = (async () => []) as unknown as DbClient;
  callable.query = query as DbClient["query"];
  return callable;
}

function recommendationEpisode() {
  return buildAdRecommendationEpisode({
    businessId: "00000000-0000-4000-8000-000000000001",
    businessDisplayId: "business-a",
    providerAccountRefId: "00000000-0000-4000-8000-000000000010",
    providerAccountId: "act-a",
    adId: "100000000000001",
    creativeId: "shared-creative",
    asOfDate: "2026-07-12",
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    scopeType: "account",
    scopeId: "*",
    snapshotId: "00000000-0000-4000-8000-000000000002",
    evaluationId: "00000000-0000-4000-8000-000000000003",
    inputHash: "1".repeat(64),
    decisionHash: "2".repeat(64),
    decisionLabel: "cut",
    sourceCampaignId: "campaign-a",
    sourceAdsetId: "adset-a",
    recommendedAt: "2026-07-12T03:00:00.000Z",
  });
}

function immutablePauseReceipt(
  target = recommendationEpisode(),
): ExactMetaAdsActionLineage {
  if (!target.creativeId) {
    throw new TypeError("Test receipt requires an exact creative identity.");
  }
  const idempotencyKey = createDecisionOriginAdActionIdempotencyKey({
    businessId: target.businessId,
    providerAccountId: target.providerAccountId,
    adId: target.adId,
    snapshotId: target.snapshotId,
    evaluationId: target.evaluationId,
    engineVersion: target.engineVersion,
    decisionHash: target.decisionHash,
    action: "pause",
  });
  const receipt: Omit<ExactMetaAdsActionLineage, "receiptHash"> = {
    receiptId: "00000000-0000-4000-8000-000000000005",
    actionLogId: "00000000-0000-4000-8000-000000000006",
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: target.businessId,
    providerAccountRefId: target.providerAccountRefId,
    providerAccountId: target.providerAccountId,
    sourceAdId: target.adId,
    sourceSnapshotId: target.snapshotId,
    sourceEvaluationId: target.evaluationId,
    sourceEngineVersion: target.engineVersion,
    sourceDecisionHash: target.decisionHash,
    targetEntityType: "ad",
    targetEntityId: target.adId,
    action: "pause",
    successorKind: null,
    resultingAdId: null,
    idempotencyKey,
    status: "success",
    dryRun: false,
    providerVerified: true,
    requestedAt: "2026-07-12T04:00:00.000Z",
    verifiedAt: "2026-07-12T04:01:00.000Z",
    finalizedAt: "2026-07-12T04:02:00.000Z",
    capturedAt: "2026-07-12T04:03:00.000Z",
    verificationEntityId: target.adId,
    verificationStatus: "PAUSED",
    verificationLineage: {
      sourceCreativeId: target.creativeId,
      sourceCampaignId: target.sourceCampaignId,
      sourceAdsetId: target.sourceAdsetId,
      verifiedProviderAccountId: target.providerAccountId,
      verifiedCreativeId: target.creativeId,
      verifiedCampaignId: target.sourceCampaignId,
      verifiedAdsetId: target.sourceAdsetId,
    },
  };
  return {
    ...receipt,
    receiptHash: buildExactMetaAdsActionReceiptHash(receipt),
  };
}

describe("native ad operator-response job contract", () => {
  it("exports parallel schema without modifying legacy or existing tables", () => {
    expect(AD_OPERATOR_RESPONSE_SCHEMA_SQL).toContain(
      `CREATE TABLE ${AD_RECOMMENDATION_EPISODES_TABLE}`,
    );
    expect(AD_OPERATOR_RESPONSE_SCHEMA_SQL).toContain(
      `CREATE TABLE ${AD_OPERATOR_ACTION_RECEIPTS_TABLE}`,
    );
    expect(AD_OPERATOR_RESPONSE_SCHEMA_SQL).toContain(
      `CREATE TABLE ${AD_OPERATOR_RESPONSE_EVENTS_TABLE}`,
    );
    expect(AD_OPERATOR_RESPONSE_SCHEMA_SQL).toContain(
      `CREATE TABLE ${AD_OPERATOR_RESPONSES_TABLE}`,
    );
    expect(AD_OPERATOR_RESPONSE_SCHEMA_SQL).not.toMatch(/ALTER\s+TABLE/i);
    expect(AD_OPERATOR_RESPONSE_SCHEMA_SQL).not.toContain(
      "engine_v3_decision_snapshots_daily",
    );
    expect(AD_OPERATOR_RESPONSE_SCHEMA_SQL).not.toContain(
      "engine_v3_decision_events",
    );
    expect(AD_OPERATOR_RESPONSE_SCHEMA_SQL).toContain(
      "UNIQUE (episode_key, response_cutoff)",
    );
    expect(AD_OPERATOR_RESPONSE_SCHEMA_SQL).toContain(
      "engine_v3_ad_operator_action_receipts_immutable",
    );
    expect(AD_OPERATOR_RESPONSE_SCHEMA_SQL).toContain(
      "unknown_incomplete",
    );
  });

  it("uses exact native lineage and cutoff-safe state history only", () => {
    expect(FIND_NATIVE_AD_RECOMMENDATION_EPISODE_CANDIDATES_QUERY).toContain(
      "evaluation.id = snapshot.evaluation_id",
    );
    expect(FIND_NATIVE_AD_RECOMMENDATION_EPISODE_CANDIDATES_QUERY).toContain(
      "evaluation.decision_hash = snapshot.decision_hash",
    );
    expect(FIND_NATIVE_AD_RECOMMENDATION_EPISODE_CANDIDATES_QUERY).toContain(
      "count(*)::integer AS binding_count",
    );
    expect(FIND_EXACT_NATIVE_AD_ACTION_RECEIPTS_QUERY).toContain(
      "receipt.source_snapshot_id = episode.snapshot_id",
    );
    expect(FIND_EXACT_NATIVE_AD_ACTION_RECEIPTS_QUERY).toContain(
      "receipt.source_evaluation_id = episode.evaluation_id",
    );
    expect(FIND_EXACT_NATIVE_AD_ACTION_RECEIPTS_QUERY).toContain(
      "receipt.provider_account_ref_id = episode.provider_account_ref_id",
    );
    expect(FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY).toContain(
      "truth.observed_at <= LEAST(truth.window_end, truth.cutoff)",
    );
    expect(FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY).toContain(
      "truth.captured_at <= truth.cutoff",
    );
    expect(FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY).toContain(
      "INNER JOIN meta_entity_tombstones tombstone",
    );
    expect(FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY).toContain(
      "(truth.evidence_kind = 'meta_entity_tombstones') DESC",
    );
    expect(FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY).toContain(
      "FROM targets target\n  INNER JOIN meta_entity_state_history state",
    );
    expect(FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY).toContain(
      "state.entity_id = target.entity_id",
    );
    expect(FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY).toContain(
      "state.observed_at <= target.cutoff",
    );
    expect(FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY).toContain(
      "truth.episode_key, truth.target_entity_type, truth.target_entity_id",
    );

    const allReadSql = [
      FIND_NATIVE_AD_RECOMMENDATION_EPISODE_CANDIDATES_QUERY,
      FIND_EXACT_NATIVE_AD_ACTION_RECEIPTS_QUERY,
      FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY,
    ].join("\n");
    expect(allReadSql).not.toContain("command_center_action_journal");
    expect(allReadSql).not.toContain("meta_ads_action_log");
    expect(allReadSql).not.toContain("meta_ad_dimensions");
    expect(allReadSql).not.toContain("meta_campaign_dimensions");
    expect(allReadSql).not.toContain("meta_adset_dimensions");
    expect(allReadSql).not.toMatch(/POSITION\s*\(/i);
    expect(allReadSql).not.toContain("payload_request");
    expect(allReadSql).not.toMatch(/creative_id\s*=/i);
  });

  it("keeps the recommendation payload record declaration duplicate-free", () => {
    const declarationStart =
      INSERT_AD_RECOMMENDATION_EPISODES_QUERY.indexOf("AS row(");
    const declarationEnd =
      INSERT_AD_RECOMMENDATION_EPISODES_QUERY.indexOf(
        "\n  )\n)\nINSERT",
        declarationStart,
      );
    expect(declarationStart).toBeGreaterThanOrEqual(0);
    expect(declarationEnd).toBeGreaterThan(declarationStart);
    const declaredColumns = INSERT_AD_RECOMMENDATION_EPISODES_QUERY
      .slice(declarationStart + "AS row(".length, declarationEnd)
      .split(",")
      .map((declaration) => declaration.trim().split(/\s+/)[0])
      .filter((column): column is string => Boolean(column));

    expect(new Set(declaredColumns).size).toBe(declaredColumns.length);
    expect(declaredColumns).toEqual(
      expect.arrayContaining([
        "job_run_id",
        "business_ref_id",
        "business_id",
        "provider_account_ref_id",
        "provider_account_id",
      ]),
    );
  });

  it("fails schema capability closed before the parallel migration exists", async () => {
    const capability = await inspectAdOperatorResponseSchemaCapability(
      dbClient(async () => []),
    );

    expect(capability.ready).toBe(false);
    expect(capability.missing).toEqual(
      expect.arrayContaining([
        `${AD_RECOMMENDATION_EPISODES_TABLE}.episode_key`,
        `${AD_OPERATOR_RESPONSE_EVENTS_TABLE}.evidence_hash`,
        `${AD_OPERATOR_RESPONSES_TABLE}.response_hash`,
      ]),
    );
  });

  it("fails capability on a wrong physical type or one-sided immutability trigger", async () => {
    const capability = await inspectAdOperatorResponseSchemaCapability(
      dbClient(async (queryText) => {
        if (queryText.includes("information_schema.columns")) {
          return [
            {
              table_name: AD_RECOMMENDATION_EPISODES_TABLE,
              column_name: "id",
              is_nullable: "NO",
              udt_name: "text",
            },
          ];
        }
        if (queryText.includes("information_schema.triggers")) {
          return [
            {
              table_name: AD_OPERATOR_ACTION_RECEIPTS_TABLE,
              trigger_name:
                "engine_v3_ad_operator_action_receipts_immutable",
              event_manipulation: "UPDATE",
              action_timing: "BEFORE",
              action_statement:
                "EXECUTE FUNCTION reject_engine_v3_ad_operator_action_receipt_mutation()",
            },
          ];
        }
        return [];
      }),
    );

    expect(capability.ready).toBe(false);
    expect(capability.missing).toEqual(
      expect.arrayContaining([
        `${AD_RECOMMENDATION_EPISODES_TABLE}.id_type_uuid`,
        `${AD_OPERATOR_ACTION_RECEIPTS_TABLE}.immutable_update_delete_trigger`,
      ]),
    );
  });

  it("does not read sources or write when the schema gate is closed", async () => {
    const queries: string[] = [];
    const db = dbClient(async (queryText) => {
      queries.push(queryText);
      if (queryText.includes("pg_try_advisory_xact_lock")) {
        return [{ acquired: true }];
      }
      if (queryText.includes("INSERT INTO engine_v3_job_runs")) {
        return [{ id: JOB_RUN_ID, status: "running" }];
      }
      if (
        queryText.includes("UPDATE engine_v3_job_runs") &&
        queryText.includes("status = 'failed'")
      ) {
        return [{ id: JOB_RUN_ID, status: "failed" }];
      }
      return [];
    });

    const result = await executeAdOperatorResponseJob(
      {
        businessId: "00000000-0000-4000-8000-000000000001",
        cutoff: CUTOFF,
      },
      db,
    );

    expect(result).toMatchObject({
      jobRunId: JOB_RUN_ID,
      status: "failed",
      reason: "schema_not_ready",
      episodesCaptured: 0,
      responsesWritten: 0,
    });
    expect(queries).not.toContain(
      FIND_NATIVE_AD_RECOMMENDATION_EPISODE_CANDIDATES_QUERY,
    );
    expect(queries).not.toContain(INSERT_AD_RECOMMENDATION_EPISODES_QUERY);
    expect(queries).not.toContain(REPLACE_AD_OPERATOR_RESPONSE_BATCHES_QUERY);
  });

  it("rejects every non-native engine epoch before touching the database", async () => {
    let queryCount = 0;
    const result = await executeAdOperatorResponseJob(
      {
        businessId: "00000000-0000-4000-8000-000000000001",
        cutoff: CUTOFF,
        engineVersion: "legacy-or-arbitrary-epoch",
      },
      dbClient(async () => {
        queryCount += 1;
        return [];
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      reason: "invalid_input",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
    });
    expect(queryCount).toBe(0);
  });

  it("captures exact episodes idempotently without creative/date dedupe", async () => {
    const stored = new Set<string>();
    const db = dbClient(async (queryText, params) => {
      expect(queryText).toBe(INSERT_AD_RECOMMENDATION_EPISODES_QUERY);
      const rows = JSON.parse(String(params?.[0])) as Array<{
        episode_key: string;
        creative_id: string | null;
        ad_id: string;
        decision_snapshot_id: string;
        evaluation_id: string;
        job_run_id: string;
      }>;
      return rows.flatMap((row) => {
        expect(row).toMatchObject({
          creative_id: "shared-creative",
          ad_id: "100000000000001",
          provider_account_ref_id:
            "00000000-0000-4000-8000-000000000010",
          decision_snapshot_id: "00000000-0000-4000-8000-000000000002",
          evaluation_id: "00000000-0000-4000-8000-000000000003",
          job_run_id: JOB_RUN_ID,
        });
        if (stored.has(row.episode_key)) return [];
        stored.add(row.episode_key);
        return [{ id: `episode-${stored.size}` }];
      });
    });
    const target = recommendationEpisode();

    await expect(
      persistAdRecommendationEpisodes([target], CUTOFF, JOB_RUN_ID, db),
    ).resolves.toBe(1);
    await expect(
      persistAdRecommendationEpisodes([target], CUTOFF, JOB_RUN_ID, db),
    ).resolves.toBe(0);
    expect(INSERT_AD_RECOMMENDATION_EPISODES_QUERY).toContain(
      "ON CONFLICT (episode_key) DO NOTHING",
    );
    await expect(
      persistAdRecommendationEpisodes(
        [target, target],
        CUTOFF,
        JOB_RUN_ID,
        db,
      ),
    ).rejects.toThrow(/duplicate keys/);
  });

  it("rejects a stored freeze whose non-identity episode payload drifted", () => {
    const target = recommendationEpisode();
    expect(() =>
      assertAdRecommendationEpisodeCapture({
        candidates: [target],
        stored: [{ ...target, sourceCampaignId: "campaign-drifted" }],
      }),
    ).toThrow(/freeze did not reconcile/);
  });

  it("derives immutable receipt lineage from the locked DB row only", async () => {
    const target = recommendationEpisode();
    const action = immutablePauseReceipt(target);
    let storedReceipt: {
      receipt_id: string;
      action_log_id: string;
      receipt_hash: string;
    } | null = null;
    const lockedRow = () => ({
      id: action.actionLogId,
      business_id: target.businessId,
      ad_id: target.adId,
      creative_id: target.creativeId,
      action: "pause",
      source: "decision_origin",
      requested_by: null,
      requested_at: action.requestedAt,
      payload_request: {},
      payload_response: {},
      status: "success",
      error_code: null,
      error_message: null,
      resulting_ad_id: null,
      duration_ms: 10,
      verified_at: action.verifiedAt,
      verification_payload: {
        id: target.adId,
        account_id: target.providerAccountId,
        creative: { id: target.creativeId },
        campaign: { id: target.sourceCampaignId },
        adset: { id: target.sourceAdsetId },
      },
      rec_id_origin: null,
      launch_intent_id: null,
      decision_contract_version: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
      provider_account_ref_id: target.providerAccountRefId,
      provider_account_id: target.providerAccountId,
      decision_episode_key: target.episodeKey,
      decision_snapshot_id: target.snapshotId,
      decision_evaluation_id: target.evaluationId,
      decision_engine_version: target.engineVersion,
      decision_hash: target.decisionHash,
      idempotency_key: action.idempotencyKey,
      dry_run: false,
      provider_verified: true,
      verification_entity_id: target.adId,
      verification_status: "PAUSED",
      terminal_finalized_at: action.finalizedAt,
      created_at: action.requestedAt,
      updated_at: action.finalizedAt,
      db_now: action.finalizedAt,
      episode_business_id: target.businessDisplayId,
      episode_creative_id: target.creativeId,
      episode_as_of_date: target.asOfDate,
      episode_scope_type: target.scopeType,
      episode_scope_id: target.scopeId,
      episode_input_hash: target.inputHash,
      episode_decision_label: target.decisionLabel,
      episode_source_campaign_id: target.sourceCampaignId,
      episode_source_adset_id: target.sourceAdsetId,
      episode_recommended_at: target.recommendedAt,
      existing_receipt_id: storedReceipt?.receipt_id ?? null,
      existing_receipt_hash: storedReceipt?.receipt_hash ?? null,
      existing_receipt_captured_at: action.finalizedAt,
    });
    const db = dbClient(async (queryText, params) => {
      if (queryText === LOCK_DECISION_ORIGIN_ACTION_FOR_FINALIZATION_QUERY) {
        expect(params).toEqual([action.actionLogId]);
        return [lockedRow()];
      }
      expect(queryText).toBe(INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY);
      const payload = JSON.parse(String(params?.[0])) as Record<string, unknown>;
      expect(payload).toMatchObject({
        source_action_log_id: action.actionLogId,
        episode_key: target.episodeKey,
        business_ref_id: target.businessId,
        provider_account_ref_id: target.providerAccountRefId,
        provider_account_id: target.providerAccountId,
        source_ad_id: target.adId,
        verification_lineage: action.verificationLineage,
      });
      storedReceipt = {
        receipt_id: String(payload.id),
        action_log_id: String(payload.source_action_log_id),
        receipt_hash: String(payload.receipt_hash),
      };
      return [storedReceipt];
    });

    const first = await persistImmutableAdOperatorActionReceipt({
      actionLogId: action.actionLogId,
      db,
    });
    const retry = await persistImmutableAdOperatorActionReceipt({
      actionLogId: action.actionLogId,
      db,
    });
    expect(retry).toEqual(first);
    expect(first.actionLogId).toBe(action.actionLogId);
  });

  it("atomically replaces and proves the complete response/evidence set", async () => {
    const target = recommendationEpisode();
    const detection = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [],
      states: [],
    });
    const unknownBatch = buildAdOperatorResponsePersistenceBatch({
      episode: target,
      jobRunId: JOB_RUN_ID,
      result: detection,
      cutoff: CUTOFF,
    });
    const evidenceHash = "3".repeat(64);
    const evidenceSetHash = canonicalSha256({
      episodeKey: target.episodeKey,
      responseCutoff: CUTOFF,
      evidenceHashes: [evidenceHash],
    });
    const replacementSetHash = canonicalSha256({
      episodeKey: target.episodeKey,
      responseCutoff: CUTOFF,
      responseHash: detection.responseHash,
      sourceSetHash: detection.sourceProof.sourceSetHash,
      evidenceSetHash,
      evidenceCount: 1,
    });
    const diagnosticBatch: AdOperatorResponsePersistenceBatch = {
      eventRows: [
        {
          contract_version: NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
          episode_key: target.episodeKey,
          response_cutoff: CUTOFF,
          evidence_kind: "engine_v3_ad_operator_action_receipt",
          evidence_source_id: "00000000-0000-4000-8000-000000000004",
          action_receipt_id: "00000000-0000-4000-8000-000000000004",
          state_history_id: null,
          evidence_observed_at: "2026-07-12T04:00:00.000Z",
          evidence_captured_at: "2026-07-12T04:01:00.000Z",
          treatment_eligible: false,
          diagnostic_code: "dry_run_action_log",
          evidence_json: { role: "non_treatment_diagnostic" },
          evidence_hash: evidenceHash,
        },
      ],
      responseRow: {
        ...unknownBatch.responseRow,
        evidence_hashes_json: [evidenceHash],
        evidence_count: 1,
        evidence_set_hash: evidenceSetHash,
        replacement_set_hash: replacementSetHash,
      },
    };
    const db = dbClient(async (queryText, params) => {
      expect(queryText).toBe(REPLACE_AD_OPERATOR_RESPONSE_BATCHES_QUERY);
      const responses = JSON.parse(String(params?.[0])) as Array<
        Record<string, string>
      >;
      const events = JSON.parse(String(params?.[1])) as Array<
        Record<string, string>
      >;
      expect(responses).toHaveLength(1);
      expect(events).toHaveLength(1);
      return [
        {
          responses_written: 1,
          events_written: 1,
          events_pruned: 0,
          response_proof_json: [
            {
              episode_key: target.episodeKey,
              response_cutoff: CUTOFF,
              replacement_set_hash: replacementSetHash,
            },
          ],
          event_proof_json: [
            {
              episode_key: target.episodeKey,
              response_cutoff: CUTOFF,
              evidence_hash: evidenceHash,
            },
          ],
        },
      ];
    });

    await expect(
      persistAdOperatorResponseBatches([diagnosticBatch], db),
    ).resolves.toEqual({
      eventsWritten: 1,
      eventsPruned: 0,
      responsesWritten: 1,
    });
    await expect(
      persistAdOperatorResponseBatches([diagnosticBatch], db),
    ).resolves.toEqual({
      eventsWritten: 1,
      eventsPruned: 0,
      responsesWritten: 1,
    });
    expect(REPLACE_AD_OPERATOR_RESPONSE_BATCHES_QUERY).toContain(
      "ON CONFLICT (episode_key, response_cutoff) DO UPDATE",
    );
    expect(REPLACE_AD_OPERATOR_RESPONSE_BATCHES_QUERY).toContain(
      "deleted_stale_events",
    );
    expect(REPLACE_AD_OPERATOR_RESPONSE_BATCHES_QUERY).toContain(
      "replacement_set_hash",
    );
  });

  it("rejects response/evidence cardinality drift before the atomic write", async () => {
    const target = recommendationEpisode();
    const batch = buildAdOperatorResponsePersistenceBatch({
      episode: target,
      jobRunId: JOB_RUN_ID,
      cutoff: CUTOFF,
      result: detectAdOperatorResponse({
        episode: target,
        cutoff: CUTOFF,
        actions: [],
        states: [],
      }),
    });
    batch.responseRow.evidence_count = 1;
    let queryCount = 0;

    await expect(
      persistAdOperatorResponseBatches(
        [batch],
        dbClient(async () => {
          queryCount += 1;
          return [];
        }),
      ),
    ).rejects.toThrow(/cardinality proof mismatch/);
    expect(queryCount).toBe(0);
  });

  it("reads latest responses only through the exact parallel contract", async () => {
    const seen: { queryText?: string; params?: unknown[] } = {};
    const db = dbClient(async (queryText, params) => {
      seen.queryText = queryText;
      seen.params = params;
      return [
        {
          response_id: "response-1",
          episode_key: "a".repeat(64),
          business_id: "00000000-0000-4000-8000-000000000001",
          business_display_id: "business-a",
          provider_account_id: "act-a",
          ad_id: "ad-a",
          creative_id: "shared-creative",
          engine_version: NATIVE_AD_ENGINE_VERSION,
          decision_snapshot_id: "snapshot-a",
          evaluation_id: "evaluation-a",
          decision_hash: "2".repeat(64),
          response_cutoff: CUTOFF,
          observation_status: "observed_response",
          response_type: "verified_pause",
          operator_response_detected: true,
          ad_treatment_detected: true,
          detected_at: "2026-07-12T04:01:00.000Z",
          action_receipt_id: "00000000-0000-4000-8000-000000000005",
          action_log_id: "log-a",
          successor_ad_id: null,
          successor_kind: null,
          budget_owner_type: null,
          budget_owner_id: null,
          window_start: "2026-07-12T03:00:00.000Z",
          window_end: "2026-08-11T03:00:00.000Z",
          window_closed: false,
          source_complete: false,
          source_set_hash: "5".repeat(64),
          action_receipt_count: 1,
          state_observation_count: 2,
          tombstone_observation_count: 0,
          required_state_target_count: 3,
          complete_state_target_count: 0,
          diagnostics_json: [],
          evidence_hashes_json: ["3".repeat(64)],
          evidence_count: 1,
          evidence_set_hash: "6".repeat(64),
          replacement_set_hash: "7".repeat(64),
          response_hash: "4".repeat(64),
        },
      ];
    });

    const rows = await readAdOperatorResponses({
      businessId: "00000000-0000-4000-8000-000000000001",
      providerAccountId: "act-a",
      adId: "ad-a",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      cutoff: CUTOFF,
      db,
    });

    expect(seen.queryText).toBe(READ_AD_OPERATOR_RESPONSES_QUERY);
    expect(seen.params).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "act-a",
      "ad-a",
      NATIVE_AD_ENGINE_VERSION,
      CUTOFF,
      100,
    ]);
    expect(rows[0]).toMatchObject({
      providerAccountId: "act-a",
      adId: "ad-a",
      creativeId: "shared-creative",
      responseType: "verified_pause",
      observationStatus: "observed_response",
      adTreatmentDetected: true,
      actionReceiptId: "00000000-0000-4000-8000-000000000005",
    });
    expect(READ_AD_OPERATOR_RESPONSES_QUERY).toContain(
      "episode.provider_account_id = $2",
    );
    expect(READ_AD_OPERATOR_RESPONSES_QUERY).toContain("episode.ad_id = $3");
    expect(READ_AD_OPERATOR_RESPONSES_QUERY).not.toMatch(/creative_id\s*=\s*\$/i);
  });

  it("does not allow a read-model caller to widen beyond the native epoch", async () => {
    let queryCount = 0;
    await expect(
      readAdOperatorResponses({
        businessId: "00000000-0000-4000-8000-000000000001",
        engineVersion: "legacy-creative-epoch",
        db: dbClient(async () => {
          queryCount += 1;
          return [];
        }),
      }),
    ).rejects.toThrow(/Native operator responses require/);
    expect(queryCount).toBe(0);
  });
});
