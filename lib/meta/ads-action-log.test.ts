import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDecisionOriginAdActionIdempotencyKey,
  type DecisionOriginAdExecutionRequest,
} from "@/lib/creative-decision-engine/execution-safety";
import {
  buildAdRecommendationEpisode,
  buildExactMetaAdsActionReceiptHash,
} from "@/lib/creative-decision-engine/ad-operator-response-detection";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock("@/lib/product-instrumentation", () => ({ recordProductInstrumentationEvent: vi.fn() }));

vi.mock("@/lib/meta/duplicate-ad-reconciliation-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/meta/duplicate-ad-reconciliation-store")
    >();
  return {
    ...actual,
    prepareMetaAdDuplicateAttempt: vi.fn(),
  };
});

const db = await import("@/lib/db");
const instrumentation = await import("@/lib/product-instrumentation");
const duplicateStore = await import(
  "@/lib/meta/duplicate-ad-reconciliation-store"
);
const {
  CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY,
  INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY,
  LOCK_DECISION_ORIGIN_ACTION_FOR_FINALIZATION_QUERY,
  LOCK_DECISION_ORIGIN_AD_ACTION_CLAIM_QUERY,
  MARK_DECISION_ORIGIN_RECONCILIATION_REQUIRED_QUERY,
  MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
  READ_MANUAL_META_AD_STATUS_RECONCILIATION_CANDIDATE_QUERY,
  READ_MANUAL_META_AD_STATUS_MUTATION_ATTEMPTS_QUERY,
  UPDATE_DECISION_ORIGIN_ACTION_TERMINAL_QUERY,
  appendManualMetaAdStatusMutationAttemptStarted,
  appendManualMetaAdStatusMutationAttemptCompleted,
  claimMetaAdDuplicateAction,
  completeMetaAdsActionLog,
  completeDecisionOriginMetaAdsActionLog,
  createDecisionOriginMetaAdsActionLog,
  createMetaAdsActionLog,
  findDecisionOriginActionByIdempotency,
  findUnresolvedDecisionOriginPendingAction,
  findRecentDuplicateActionResult,
  hasUnresolvedMetaAdStatusAction,
  markDecisionOriginActionReconciliationRequired,
  providerActionForNativeAuthorization,
  readManualMetaAdStatusReconciliationCandidate,
  readDecisionOriginSourceDecision,
  readLaunchpadCreatedAdIds,
  resolveExactMetaAdActionTarget,
  resolveManualMetaAdActionTarget,
  resolveMetaAdActionTarget,
} = await import("./ads-action-log");

const DECISION_HASH = "d".repeat(64);
const CANONICAL_DECISION_KEY = createDecisionOriginAdActionIdempotencyKey({
  businessId: "business_1",
  providerAccountId: "act_123",
  adId: "123456789012345",
  snapshotId: "snapshot_1",
  evaluationId: "evaluation_1",
  engineVersion: NATIVE_AD_ENGINE_VERSION,
  decisionHash: DECISION_HASH,
  action: "pause",
});
const NATIVE_EPISODE = buildAdRecommendationEpisode({
  businessId: "business_1",
  businessDisplayId: "business_1",
  providerAccountRefId: "provider_ref_1",
  providerAccountId: "act_123",
  adId: "123456789012345",
  creativeId: "creative_1",
  asOfDate: "2026-07-12",
  engineVersion: NATIVE_AD_ENGINE_VERSION,
  scopeType: "account",
  scopeId: "*",
  snapshotId: "snapshot_1",
  evaluationId: "evaluation_1",
  inputHash: "a".repeat(64),
  decisionHash: DECISION_HASH,
  decisionLabel: "cut",
  sourceCampaignId: "campaign_1",
  sourceAdsetId: "adset_1",
  recommendedAt: "2026-07-12T09:00:00.000Z",
});
const EXACT_RECEIPT_HASH = buildExactMetaAdsActionReceiptHash({
  receiptId: "receipt_1",
  actionLogId: "log_1",
  contractVersion: "meta-decision-origin-ad-execution.v1",
  businessId: NATIVE_EPISODE.businessId,
  providerAccountRefId: NATIVE_EPISODE.providerAccountRefId,
  providerAccountId: NATIVE_EPISODE.providerAccountId,
  sourceAdId: NATIVE_EPISODE.adId,
  sourceSnapshotId: NATIVE_EPISODE.snapshotId,
  sourceEvaluationId: NATIVE_EPISODE.evaluationId,
  sourceEngineVersion: NATIVE_EPISODE.engineVersion,
  sourceDecisionHash: NATIVE_EPISODE.decisionHash,
  targetEntityType: "ad",
  targetEntityId: NATIVE_EPISODE.adId,
  action: "pause",
  successorKind: null,
  resultingAdId: null,
  idempotencyKey: CANONICAL_DECISION_KEY,
  status: "success",
  dryRun: false,
  providerVerified: true,
  requestedAt: "2026-07-12T10:00:00.000Z",
  verifiedAt: "2026-07-12T10:00:01.000Z",
  finalizedAt: "2026-07-12T10:00:01.000Z",
  capturedAt: "2026-07-12T10:00:01.000Z",
  verificationEntityId: NATIVE_EPISODE.adId,
  verificationStatus: "PAUSED",
  verificationLineage: {
    sourceCreativeId: NATIVE_EPISODE.creativeId,
    sourceCampaignId: NATIVE_EPISODE.sourceCampaignId,
    sourceAdsetId: NATIVE_EPISODE.sourceAdsetId,
    verifiedProviderAccountId: NATIVE_EPISODE.providerAccountId,
    verifiedCreativeId: NATIVE_EPISODE.creativeId,
    verifiedCampaignId: NATIVE_EPISODE.sourceCampaignId,
    verifiedAdsetId: NATIVE_EPISODE.sourceAdsetId,
  },
});

function decisionRequest(
  overrides: Partial<DecisionOriginAdExecutionRequest> = {},
): DecisionOriginAdExecutionRequest {
  const request = {
    contractVersion: "meta-decision-origin-ad-execution.v1" as const,
    businessId: "business_1",
    providerAccountId: "act_123",
    adId: "123456789012345",
    snapshotId: "snapshot_1",
    evaluationId: "evaluation_1",
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    decisionHash: DECISION_HASH,
    action: "pause",
    idempotencyKey: "",
    creativeId: "creative_1",
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "idempotencyKey")) {
    request.idempotencyKey =
      createDecisionOriginAdActionIdempotencyKey(request);
  }
  return request;
}

function decisionLogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "log_1",
    business_id: "business_1",
    ad_id: "123456789012345",
    creative_id: "creative_1",
    action: "pause",
    source: "decision_origin",
    requested_by: "user_1",
    requested_at: "2026-07-12T10:00:00.000Z",
    payload_request: {
      contract_version: "meta-decision-origin-ad-execution.v1",
      execution_origin: "decision_origin",
      provider_account_id: "act_123",
      source_snapshot_id: "snapshot_1",
      source_evaluation_id: "evaluation_1",
      engine_version: NATIVE_AD_ENGINE_VERSION,
      decision_hash: DECISION_HASH,
      idempotency_key: CANONICAL_DECISION_KEY,
      dry_run: false,
    },
    payload_response: { success: true },
    status: "success",
    error_code: null,
    error_message: null,
    resulting_ad_id: null,
    duration_ms: 100,
    verified_at: "2026-07-12T10:00:01.000Z",
    verification_payload: {
      id: "123456789012345",
      account_id: "123",
      status: "PAUSED",
      effective_status: "PAUSED",
      creative: { id: "creative_1" },
      campaign: { id: "campaign_1" },
      adset: { id: "adset_1" },
    },
    rec_id_origin: null,
    launch_intent_id: null,
    decision_contract_version: "meta-decision-origin-ad-execution.v1",
    provider_account_ref_id: "provider_ref_1",
    provider_account_id: "act_123",
    decision_episode_key: NATIVE_EPISODE.episodeKey,
    decision_snapshot_id: "snapshot_1",
    decision_evaluation_id: "evaluation_1",
    decision_engine_version: NATIVE_AD_ENGINE_VERSION,
    decision_hash: DECISION_HASH,
    idempotency_key: CANONICAL_DECISION_KEY,
    dry_run: false,
    provider_verified: true,
    verification_entity_id: "123456789012345",
    verification_status: "PAUSED",
    terminal_finalized_at: "2026-07-12T10:00:01.000Z",
    created_at: "2026-07-12T10:00:00.000Z",
    updated_at: "2026-07-12T10:00:01.000Z",
    episode_business_id: NATIVE_EPISODE.businessDisplayId,
    episode_creative_id: "creative_1",
    episode_as_of_date: NATIVE_EPISODE.asOfDate,
    episode_scope_type: NATIVE_EPISODE.scopeType,
    episode_scope_id: NATIVE_EPISODE.scopeId,
    episode_input_hash: NATIVE_EPISODE.inputHash,
    episode_decision_label: NATIVE_EPISODE.decisionLabel,
    episode_source_campaign_id: "campaign_1",
    episode_source_adset_id: "adset_1",
    episode_recommended_at: NATIVE_EPISODE.recommendedAt,
    authority_snapshot_id: NATIVE_EPISODE.snapshotId,
    authority_evaluation_id: NATIVE_EPISODE.evaluationId,
    existing_receipt_id: "receipt_1",
    existing_receipt_hash: EXACT_RECEIPT_HASH,
    existing_receipt_captured_at: "2026-07-12T10:00:01.000Z",
    ...overrides,
  };
}

function queryableSqlMock(...responses: unknown[][]) {
  const query = vi.fn();
  responses.forEach((response) => query.mockResolvedValueOnce(response));
  const sql = vi.fn();
  Object.assign(sql, { query });
  return { sql, query };
}

function decisionOriginCreateSqlMock(input: {
  insertedRows: unknown[];
  existingRows?: unknown[];
  pendingRows?: unknown[];
}) {
  const query = vi.fn(async (queryText: string, _params?: unknown[]) => {
    if (queryText === LOCK_DECISION_ORIGIN_AD_ACTION_CLAIM_QUERY) return [];
    if (queryText === CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY) {
      return input.insertedRows;
    }
    throw new Error(`Unexpected query: ${queryText}`);
  });
  const sql = vi
    .fn()
    .mockResolvedValueOnce(input.pendingRows ?? [])
    .mockResolvedValueOnce(input.existingRows ?? []);
  Object.assign(sql, { query });
  return { sql, query };
}

function lockedDecisionLogRow(overrides: Record<string, unknown> = {}) {
  return {
    ...decisionLogRow(),
    db_now: "2026-07-12T10:00:01.000Z",
    episode_business_id: NATIVE_EPISODE.businessDisplayId,
    episode_creative_id: NATIVE_EPISODE.creativeId,
    episode_as_of_date: NATIVE_EPISODE.asOfDate,
    episode_scope_type: NATIVE_EPISODE.scopeType,
    episode_scope_id: NATIVE_EPISODE.scopeId,
    episode_input_hash: NATIVE_EPISODE.inputHash,
    episode_decision_label: NATIVE_EPISODE.decisionLabel,
    episode_source_campaign_id: NATIVE_EPISODE.sourceCampaignId,
    episode_source_adset_id: NATIVE_EPISODE.sourceAdsetId,
    episode_recommended_at: NATIVE_EPISODE.recommendedAt,
    existing_receipt_id: null,
    existing_receipt_hash: null,
    existing_receipt_captured_at: null,
    ...overrides,
  };
}

function manualReconciliationCandidateSource(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    business_id: "22222222-2222-4222-8222-222222222222",
    provider_account_id: "act_123",
    ad_id: "123456789012345",
    creative_id: "creative_1",
    action: "pause",
    source: "manual_operator_v1",
    requested_at: "2026-07-19T10:00:00.000Z",
    updated_at: "2026-07-19T10:00:00.000Z",
    verified_at: null,
    payload_request: {
      mutation_journal_contract_version:
        MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
      mutation_journal_required: true,
      manual_status_mutation_target: {
        businessId: "22222222-2222-4222-8222-222222222222",
        providerAccountId: "act_123",
        adId: "123456789012345",
        creativeId: "creative_1",
        campaignId: "campaign_1",
        adsetId: "adset_1",
      },
    },
    status: "pending",
    dry_run: false,
    terminal_finalized_at: null,
    bound_provider_account_ref_id:
      "33333333-3333-4333-8333-333333333333",
    bound_provider_account_count: 1,
    db_now: "2026-07-19T10:05:00.000Z",
    unresolved_source_count: 1,
    ...overrides,
  };
}

function manualMutationAttemptStartedDbRow(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    contract_version:
      MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
    source_action_log_id:
      "11111111-1111-4111-8111-111111111111",
    business_id: "22222222-2222-4222-8222-222222222222",
    provider_account_ref_id:
      "33333333-3333-4333-8333-333333333333",
    provider_account_id: "act_123",
    ad_id: "123456789012345",
    creative_id: "creative_1",
    campaign_id: "campaign_1",
    adset_id: "adset_1",
    action: "pause",
    attempt_id: "55555555-5555-4555-8555-555555555555",
    event_kind: "attempt_started",
    post_path: "/123456789012345",
    started_at: "2026-07-19T10:00:00.000Z",
    lease_deadline: "2026-07-19T10:02:00.000Z",
    attempted_at: null,
    completed_at: null,
    completion_outcome: null,
    provider_response_received: null,
    provider_response_successful: null,
    http_status: null,
    provider_outcome: null,
    provider_response_json: null,
    verification_json: null,
    transport_error_json: null,
    evidence_json: {
      contractVersion:
        MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
      eventKind: "attempt_started",
    },
    evidence_hash: "a".repeat(64),
    created_at: "2026-07-19T10:00:00.000Z",
    ...overrides,
  };
}

describe("resolveMetaAdActionTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves decision-origin targets by exact business/account/ad only", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: "business_1" }])
      .mockResolvedValueOnce([
        {
          provider_account_id: "act_123",
          ad_id: "123456789012345",
          creative_id: "shared_creative",
        },
      ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await resolveExactMetaAdActionTarget({
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "123456789012345",
    });

    expect(result).toEqual({
      ok: true,
      target: {
        businessId: "business_1",
        providerAccountId: "act_123",
        adId: "123456789012345",
        creativeId: "shared_creative",
      },
    });
    const resolveSql = String(sql.mock.calls[1]?.[0]?.join(""));
    expect(resolveSql).toContain("provider_account_id =");
    expect(resolveSql).toContain("ad_id =");
    expect(resolveSql).not.toContain("creative_id =");
    expect(resolveSql).not.toContain("meta_ads_action_log");
  });

  it("rejects an exact lookup instead of selecting another ad for the same creative", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: "business_1" }])
      .mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      resolveExactMetaAdActionTarget({
        businessId: "business_1",
        providerAccountId: "act_123",
        adId: "123456789012346",
      }),
    ).resolves.toEqual({ ok: false, reason: "ad_not_found" });
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("rejects a synthetic exact Ad identity before any database lookup", async () => {
    const sql = vi.fn();
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      resolveExactMetaAdActionTarget({
        businessId: "business_1",
        providerAccountId: "act_123",
        adId: "ad_123",
      }),
    ).resolves.toEqual({ ok: false, reason: "ad_not_found" });
    expect(sql).not.toHaveBeenCalled();
  });

  it("resolves a just-created launch ad from action logs before warehouse sync", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: "business_1" }])
      .mockResolvedValueOnce([
        {
          provider_account_id: "act_123",
          resolved_ad_id: "new_ad_1",
          creative_id: "creative_1",
        },
      ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await resolveManualMetaAdActionTarget({
      businessId: "business_1",
      adId: "new_ad_1",
    });

    expect(result).toEqual({
      ok: true,
      target: {
        businessId: "business_1",
        adId: "new_ad_1",
        creativeId: "creative_1",
        providerAccountId: "act_123",
      },
    });
    const resolveSql = String(sql.mock.calls[1]?.[0]?.join(""));
    expect(resolveSql).toContain("meta_ads_action_log");
    expect(resolveSql).toContain("log.resulting_ad_id = target.input_id");
    expect(resolveSql).toContain("::text AS business_id_text");
    expect(resolveSql).toContain("::uuid AS business_id_uuid");
    expect(resolveSql).toContain("NULL::text AS creative_id");
    expect(resolveSql).toContain("meta_creative_daily");
    expect(resolveSql).toContain("creative_daily_by_creative");
    expect(resolveMetaAdActionTarget).toBe(resolveManualMetaAdActionTarget);
  });

  it("persists rec_id_origin when provided", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      {
        id: "log_1",
        business_id: "business_1",
        ad_id: "ad_1",
        creative_id: "creative_1",
        action: "pause",
        source: "ui_manual",
        requested_by: "user_1",
        requested_at: "2026-05-06T10:00:00.000Z",
        payload_request: { body: { status: "PAUSED" } },
        payload_response: null,
        status: "pending",
        error_code: null,
        error_message: null,
        resulting_ad_id: null,
        duration_ms: null,
        verified_at: null,
        verification_payload: null,
        rec_id_origin: "rec_1",
        launch_intent_id: "intent_1",
        created_at: "2026-05-06T10:00:00.000Z",
        updated_at: "2026-05-06T10:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const row = await createMetaAdsActionLog({
      businessId: "business_1",
      adId: "ad_1",
      creativeId: "creative_1",
      action: "pause",
      requestedBy: "user_1",
      payloadRequest: { body: { status: "PAUSED" } },
      recIdOrigin: "rec_1",
      launchIntentId: "intent_1",
    });

    expect(row.recIdOrigin).toBe("rec_1");
    expect(row.launchIntentId).toBe("intent_1");
    const insertSql = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(insertSql).toContain("rec_id_origin");
    expect(insertSql).toContain("launch_intent_id");
    expect(sql.mock.calls[0]).toContain("intent_1");
  });

  it("only completes a manual action from pending", async () => {
    const pending = decisionLogRow({
      source: "manual_operator_v1",
      status: "pending",
      decision_contract_version: null,
      decision_episode_key: null,
      decision_snapshot_id: null,
      decision_evaluation_id: null,
      decision_engine_version: null,
      decision_hash: null,
      idempotency_key: null,
      provider_verified: false,
      payload_response: null,
      verification_payload: null,
    });
    const completed = decisionLogRow({
      source: "manual_operator_v1",
      status: "success",
      decision_contract_version: null,
      decision_episode_key: null,
      decision_snapshot_id: null,
      decision_evaluation_id: null,
      decision_engine_version: null,
      decision_hash: null,
      idempotency_key: null,
      provider_verified: false,
      payload_response: { success: true },
      verification_payload: { id: "123456789012345", status: "PAUSED" },
    });
    const sql = vi
      .fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([completed]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const row = await completeMetaAdsActionLog({
      id: "log_1",
      status: "success",
      payloadResponse: { success: true },
      verifiedAt: "2026-07-12T10:00:01.000Z",
      verificationPayload: {
        id: "123456789012345",
        status: "PAUSED",
      },
    });

    expect(row.status).toBe("success");
    const updateSql = String(sql.mock.calls[1]?.[0]?.join(""));
    expect(updateSql).toContain("status = 'pending'");
    const updateSetClause = updateSql.split("WHERE")[0] ?? updateSql;
    for (const immutableColumn of [
      "business_id",
      "provider_account_ref_id",
      "provider_account_id",
      "ad_id",
      "creative_id",
      "action",
      "source",
      "requested_by",
      "requested_at",
      "payload_request",
      "dry_run",
      "idempotency_key",
      "decision_contract_version",
    ]) {
      expect(updateSetClause).not.toMatch(
        new RegExp(`(?:^|[,\\n])\\s*${immutableColumn}\\s*=`),
      );
    }
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("rejects a runtime pending manual completion before touching the database", async () => {
    await expect(
      completeMetaAdsActionLog({
        id: "log_1",
        status: "pending",
      } as never),
    ).rejects.toThrow("Manual action completion requires a terminal status.");
    expect(db.getDb).not.toHaveBeenCalled();
  });

  it("treats an identical manual terminal completion replay as idempotent", async () => {
    const completed = decisionLogRow({
      source: "manual_operator_v1",
      status: "success",
      decision_contract_version: null,
      decision_episode_key: null,
      decision_snapshot_id: null,
      decision_evaluation_id: null,
      decision_engine_version: null,
      decision_hash: null,
      idempotency_key: null,
      provider_verified: false,
      payload_response: { success: true },
      verification_payload: { id: "123456789012345", status: "PAUSED" },
    });
    const sql = vi.fn().mockResolvedValueOnce([completed]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const row = await completeMetaAdsActionLog({
      id: "log_1",
      status: "success",
      payloadResponse: { ignored: undefined, success: true },
      durationMs: 100,
      verifiedAt: "2026-07-12T10:00:01.000Z",
      verificationPayload: {
        status: "PAUSED",
        ignored: undefined,
        id: "123456789012345",
      },
    });

    expect(row.status).toBe("success");
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("never overwrites a committed manual success with a different terminal outcome", async () => {
    const completed = decisionLogRow({
      source: "manual_operator_v1",
      status: "success",
      decision_contract_version: null,
      decision_episode_key: null,
      decision_snapshot_id: null,
      decision_evaluation_id: null,
      decision_engine_version: null,
      decision_hash: null,
      idempotency_key: null,
      provider_verified: false,
      payload_response: { success: true },
      verification_payload: { id: "123456789012345", status: "PAUSED" },
    });
    const sql = vi.fn().mockResolvedValueOnce([completed]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      completeMetaAdsActionLog({
        id: "log_1",
        status: "failure",
        errorCode: "internal_error",
        errorMessage: "late handler error",
      }),
    ).rejects.toThrow(
      "Meta ads action log already has a different terminal outcome.",
    );
    expect(sql).toHaveBeenCalledTimes(1);
    const readSql = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(readSql).toContain("SELECT");
  });

  it.each([
    [
      "node-pg Date",
      new Date("2026-07-12T10:00:01.000Z"),
      "2026-07-12T10:00:01.000Z",
    ],
    [
      "offset timestamp string",
      "2026-07-12T13:00:01.000+03:00",
      "2026-07-12T10:00:01.000Z",
    ],
  ])(
    "normalizes %s action timestamps to canonical UTC ISO",
    async (_label, timestamp, expected) => {
      const sql = vi.fn().mockResolvedValueOnce([
        decisionLogRow({
          source: "ui_manual",
          decision_contract_version: null,
          requested_at: timestamp,
          verified_at: timestamp,
          terminal_finalized_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
        }),
      ]);
      vi.mocked(db.getDb).mockReturnValue(sql as never);

      const row = await createMetaAdsActionLog({
        businessId: "business_1",
        adId: "123456789012345",
        action: "pause",
      });

      expect(row).toMatchObject({
        requestedAt: expected,
        verifiedAt: expected,
        terminalFinalizedAt: expected,
        createdAt: expected,
        updatedAt: expected,
      });
    },
  );

  it("fails closed when a manual status claim omits exact provider-account identity", async () => {
    await expect(
      createMetaAdsActionLog({
        businessId: "business_1",
        adId: "123456789012345",
        creativeId: "creative_1",
        action: "pause",
        source: "manual_operator_v1",
      }),
    ).rejects.toThrow(
      "Meta status claims require exact provider_account_id.",
    );
    expect(db.getDb).not.toHaveBeenCalled();
  });

  it("persists exact provider-account identity under the shared manual status claim lock", async () => {
    const pendingManualRow = decisionLogRow({
      source: "manual_operator_v1",
      status: "pending",
      provider_account_ref_id: null,
      provider_account_id: "act_123",
      decision_contract_version: null,
      decision_episode_key: null,
      decision_snapshot_id: null,
      decision_evaluation_id: null,
      decision_engine_version: null,
      decision_hash: null,
      idempotency_key: null,
      dry_run: true,
      verified_at: null,
      provider_verified: false,
      terminal_finalized_at: null,
    });
    const query = vi.fn(async (text: string) =>
      text.includes("FROM business_provider_accounts")
        ? [
            {
              provider_account_ref_id:
                "33333333-3333-4333-8333-333333333333",
              binding_count: 1,
            },
          ]
        : [],
    );
    const sql = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingManualRow]);
    Object.assign(sql, { query });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const row = await createMetaAdsActionLog({
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "123456789012345",
      creativeId: "creative_1",
      action: "pause",
      source: "manual_operator_v1",
      requestedBy: "user_1",
      payloadRequest: { dry_run: true },
    });

    expect(row).toMatchObject({
      source: "manual_operator_v1",
      providerAccountId: "act_123",
      status: "pending",
      dryRun: true,
    });
    expect(query).toHaveBeenCalledWith(
      LOCK_DECISION_ORIGIN_AD_ACTION_CLAIM_QUERY,
      [JSON.stringify(["business_1", "act_123", "123456789012345"])],
    );
    const insertSql = String(sql.mock.calls[1]?.[0]?.join(""));
    expect(insertSql).toContain("provider_account_id");
    expect(insertSql).toContain("dry_run");
    expect(sql.mock.calls[1]).toContain("act_123");
    expect(sql.mock.calls[1]).toContain(true);
  });

  it.each(["campaign", "adset", "ad"] as const)("serializes manual and scheduled %s status claims with truthful origins", async (scope) => {
    for (const source of ["manual_operator_v1", "scheduled_automation_v1"] as const) {
      vi.mocked(instrumentation.recordProductInstrumentationEvent).mockClear();
      const requestedBy = source === "manual_operator_v1" ? "user_1" : null;
      const query = vi.fn(async () => []);
      const sql = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([
        decisionLogRow({ source, requested_by: requestedBy, provider_account_id: "act_123" }),
      ]);
      Object.assign(sql, { query });
      vi.mocked(db.getDb).mockReturnValue(sql as never);

      await createMetaAdsActionLog({
        businessId: "business_1", providerAccountId: "act_123", adId: "entity_1",
        action: "resume", source, requestedBy, payloadRequest: { scope_type: scope, dry_run: false },
      });

      expect(query).toHaveBeenCalledWith(LOCK_DECISION_ORIGIN_AD_ACTION_CLAIM_QUERY,
        [JSON.stringify(["business_1", "act_123", "entity_1"])]);
      expect(String(sql.mock.calls[0][0].join(""))).toContain("FROM meta_ads_action_log action_log");
      expect(String(sql.mock.calls[1][0].join(""))).toContain("INSERT INTO meta_ads_action_log");
      expect(sql.mock.calls[1]).toContain(source);
      expect(sql.mock.calls[1][8]).toBe(requestedBy);
      expect(instrumentation.recordProductInstrumentationEvent).toHaveBeenCalledTimes(source === "manual_operator_v1" ? 1 : 0);
    }
  });

  it.each(["manual_operator_v1", "scheduled_automation_v1"] as const)("refuses %s before inserting when the unresolved-status read fails", async (source) => {
    const query = vi.fn(async () => []);
    const sql = vi.fn().mockRejectedValueOnce(new Error("status read unavailable"));
    Object.assign(sql, { query });
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    await expect(createMetaAdsActionLog({
      businessId: "business_1", providerAccountId: "act_123", adId: "entity_1",
      action: "pause", source, payloadRequest: { scope_type: "campaign" },
    })).rejects.toThrow("status read unavailable");
    expect(sql).toHaveBeenCalledTimes(1);
    expect(String(sql.mock.calls[0][0].join(""))).not.toContain("INSERT");
    expect(instrumentation.recordProductInstrumentationEvent).not.toHaveBeenCalled();
  });

  it("blocks a new manual claim behind an indefinite legacy manual pending row with null account", async () => {
    const legacyPending = decisionLogRow({
      id: "legacy_manual_pending",
      source: "ui_manual",
      status: "pending",
      provider_account_ref_id: null,
      provider_account_id: null,
      decision_contract_version: null,
      decision_episode_key: null,
      decision_snapshot_id: null,
      decision_evaluation_id: null,
      decision_engine_version: null,
      decision_hash: null,
      idempotency_key: null,
      verified_at: null,
      provider_verified: false,
      terminal_finalized_at: null,
    });
    const query = vi.fn(async (text: string) =>
      text.includes("FROM business_provider_accounts")
        ? [
            {
              provider_account_ref_id:
                "33333333-3333-4333-8333-333333333333",
              binding_count: 1,
            },
          ]
        : [],
    );
    const sql = vi.fn().mockResolvedValueOnce([legacyPending]);
    Object.assign(sql, { query });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const attempt = createMetaAdsActionLog({
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "123456789012345",
      creativeId: "creative_1",
      action: "pause",
      source: "manual_operator_v1",
    });
    await expect(attempt).rejects.toMatchObject({
      code: "action_in_flight",
      blockingActionLogId: "legacy_manual_pending",
      blockingOrigin: "ui_manual",
      reconciliationRequired: false,
    });
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("detects unresolved exact-account and legacy null-account status actions without a time window", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      decisionLogRow({
        id: "five_minute_old_legacy_pending",
        source: "ui_manual",
        status: "pending",
        provider_account_ref_id: null,
        provider_account_id: null,
        decision_contract_version: null,
        decision_episode_key: null,
        decision_snapshot_id: null,
        decision_evaluation_id: null,
        decision_engine_version: null,
        decision_hash: null,
        idempotency_key: null,
        requested_at: "2026-07-18T13:55:00.000Z",
        verified_at: null,
        provider_verified: false,
        terminal_finalized_at: null,
      }),
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      hasUnresolvedMetaAdStatusAction({
        businessId: "business_1",
        providerAccountId: "act_123",
        adId: "123456789012345",
      }),
    ).resolves.toBe(true);

    const pendingSql = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(pendingSql).toContain("action IN ('pause', 'resume')");
    expect(pendingSql).toContain("provider_account_id IS NULL");
    expect(pendingSql).toContain("source <> 'decision_origin'");
    expect(pendingSql).toContain("status = 'silent_failure'");
    expect(pendingSql).toContain("payload_request->>'dry_run' = 'true'");
    expect(pendingSql).not.toContain("requested_at >");
    expect(sql.mock.calls[0]).toContain("business_1");
    expect(sql.mock.calls[0]).toContain("act_123");
    expect(sql.mock.calls[0]).toContain("123456789012345");
  });

  it("blocks every later status claim behind an unresolved manual live silent failure", async () => {
    const unresolvedManualTerminal = decisionLogRow({
      id: "manual_ambiguous_terminal",
      source: "manual_operator_v1",
      status: "silent_failure",
      error_code: "provider_outcome_ambiguous",
      provider_account_ref_id: null,
      provider_account_id: "act_123",
      decision_contract_version: null,
      decision_episode_key: null,
      decision_snapshot_id: null,
      decision_evaluation_id: null,
      decision_engine_version: null,
      decision_hash: null,
      idempotency_key: null,
      dry_run: false,
      verified_at: null,
      provider_verified: false,
      terminal_finalized_at: null,
    });
    const query = vi.fn().mockResolvedValue([]);
    const sql = vi.fn().mockResolvedValueOnce([unresolvedManualTerminal]);
    Object.assign(sql, { query });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      createMetaAdsActionLog({
        businessId: "business_1",
        providerAccountId: "act_123",
        adId: "123456789012345",
        creativeId: "creative_1",
        action: "pause",
        source: "manual_operator_v1",
      }),
    ).rejects.toMatchObject({
      code: "meta_ad_status_reconciliation_required",
      blockingActionLogId: "manual_ambiguous_terminal",
      blockingOrigin: "manual_operator_v1",
      reconciliationRequired: true,
    });
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("blocks a native claim behind an all-origin manual pending row", async () => {
    const manualPending = decisionLogRow({
      id: "manual_pending",
      source: "manual_operator_v1",
      status: "pending",
      provider_account_ref_id: null,
      provider_account_id: "act_123",
      decision_contract_version: null,
      decision_episode_key: null,
      decision_snapshot_id: null,
      decision_evaluation_id: null,
      decision_engine_version: null,
      decision_hash: null,
      idempotency_key: null,
      verified_at: null,
      provider_verified: false,
      terminal_finalized_at: null,
    });
    const { sql } = decisionOriginCreateSqlMock({
      insertedRows: [],
      pendingRows: [manualPending],
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      createDecisionOriginMetaAdsActionLog({
        request: decisionRequest(),
        requestedBy: "user_1",
      }),
    ).rejects.toMatchObject({
      code: "action_in_flight",
      blockingActionLogId: "manual_pending",
      blockingOrigin: "manual_operator_v1",
      reconciliationRequired: false,
    });
  });

  it("keeps a marked native pending row as action_in_flight for a manual loser", async () => {
    const markedNativePending = decisionLogRow({
      id: "marked_native_pending",
      status: "pending",
      error_code: "provider_verification_persistence_failed",
      payload_response: {
        decision_origin_reconciliation: {
          reconciliation_required: true,
          retry_allowed: false,
          outcome: "provider_outcome_ambiguous",
          provider_outcome_ambiguous: true,
        },
      },
      verified_at: null,
      provider_verified: false,
      terminal_finalized_at: null,
    });
    const query = vi.fn().mockResolvedValue([]);
    const sql = vi.fn().mockResolvedValueOnce([markedNativePending]);
    Object.assign(sql, { query });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const attempt = createMetaAdsActionLog({
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "123456789012345",
      creativeId: "creative_1",
      action: "pause",
      source: "manual_operator_v1",
    });

    await expect(attempt).rejects.toMatchObject({
      code: "action_in_flight",
      blockingActionLogId: "marked_native_pending",
      blockingOrigin: "native_decision_v1",
      reconciliationRequired: true,
      reconciliationReceipt: expect.objectContaining({
        reconciliationRequired: true,
        providerOutcomeAmbiguous: true,
      }),
    });
  });

  it("keeps a marked native different-key loser on the pending-reconciliation code", async () => {
    const markedNativePending = decisionLogRow({
      id: "marked_native_pending",
      status: "pending",
      idempotency_key: "different-canonical-key",
      error_code: "provider_verification_persistence_failed",
      payload_response: {
        decision_origin_reconciliation: {
          reconciliation_required: true,
          retry_allowed: false,
          outcome: "provider_outcome_ambiguous",
          provider_outcome_ambiguous: true,
        },
      },
      verified_at: null,
      provider_verified: false,
      terminal_finalized_at: null,
    });
    const { sql } = decisionOriginCreateSqlMock({
      insertedRows: [],
      pendingRows: [markedNativePending],
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const attempt = createDecisionOriginMetaAdsActionLog({
      request: decisionRequest(),
      requestedBy: "user_1",
    });

    await expect(attempt).rejects.toMatchObject({
      code: "decision_origin_pending_reconciliation_required",
      blockingActionLogId: "marked_native_pending",
      blockingOrigin: "native_decision_v1",
      reconciliationRequired: true,
      reconciliationReceipt: expect.objectContaining({
        reconciliationRequired: true,
        providerOutcomeAmbiguous: true,
      }),
    });
  });

  it("deduplicates completed duplicates by source and target regardless of legacy status option", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      {
        id: "log_1",
        business_id: "business_1",
        ad_id: "source_ad_1",
        creative_id: "creative_1",
        action: "duplicate",
        source: "ui_manual",
        requested_by: "user_1",
        requested_at: "2026-05-06T10:00:00.000Z",
        payload_request: {
          body: {
            target_adset_id: "target_adset_1",
            status_option: "ACTIVE",
          },
        },
        payload_response: { id: "duplicate_ad_1" },
        status: "success",
        error_code: null,
        error_message: null,
        resulting_ad_id: "duplicate_ad_1",
        duration_ms: 100,
        verified_at: "2026-05-06T10:00:01.000Z",
        verification_payload: { status: "ACTIVE" },
        rec_id_origin: null,
        created_at: "2026-05-06T10:00:00.000Z",
        updated_at: "2026-05-06T10:00:01.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await findRecentDuplicateActionResult({
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "source_ad_1",
      targetAdsetId: "target_adset_1",
      sinceMinutes: 10,
    });

    expect(result?.resultingAdId).toBe("duplicate_ad_1");
    const querySql = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(querySql).toContain("AND ad_id =");
    expect(querySql).toContain("target_adset_id");
    expect(querySql).toContain(
      "status IN ('pending', 'success', 'silent_failure')",
    );
    expect(querySql).toContain("provider_account_id =");
    expect(querySql).toContain("COALESCE(dry_run, FALSE)");
    expect(querySql).toContain("payload_request->'body'->>'dry_run'");
    expect(querySql).not.toContain("resulting_ad_id IS NOT NULL");
    expect(querySql).toContain("OR status = 'pending'");
    expect(querySql).toContain("OR status = 'silent_failure'");
    expect(querySql).toContain("status = 'failure'");
    expect(querySql).toContain(
      "NULLIF(btrim(provider_account_id), '') IS NOT NULL",
    );
    expect(querySql).toContain(
      "payload_request->>'duplicate_attempt_contract_version'",
    );
    expect(querySql).toContain(
      "payload_request->'duplicate_attempt_required'",
    );
    expect(querySql).not.toContain(
      "status = 'silent_failure' AND resulting_ad_id IS NULL",
    );
    expect(querySql).not.toContain("status_option");
    expect(sql.mock.calls[0]?.slice(1)).toEqual([
      "business_1",
      "act_123",
      "source_ad_1",
      "meta-manual-ad-duplicate-attempt.v1",
      "target_adset_1",
      10,
    ]);
  });

  it("claims an exact live duplicate tuple under one transaction lock before provider execution", async () => {
    const pendingDuplicate = decisionLogRow({
      id: "duplicate_claim_1",
      source: "manual_operator_v1",
      action: "duplicate",
      status: "pending",
      provider_account_ref_id: null,
      provider_account_id: "act_123",
      decision_contract_version: null,
      decision_episode_key: null,
      decision_snapshot_id: null,
      decision_evaluation_id: null,
      decision_engine_version: null,
      decision_hash: null,
      idempotency_key: null,
      dry_run: false,
      payload_request: {
        dry_run: false,
        body: { target_adset_id: "target_adset_1" },
      },
      verified_at: null,
      provider_verified: false,
      terminal_finalized_at: null,
    });
    const query = vi.fn(async (text: string) =>
      text.includes("FROM business_provider_accounts")
        ? [
            {
              provider_account_ref_id:
                "33333333-3333-4333-8333-333333333333",
              binding_count: 1,
            },
          ]
        : [],
    );
    const sql = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingDuplicate]);
    Object.assign(sql, { query });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await claimMetaAdDuplicateAction({
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "source_ad_1",
      creativeId: "creative_1",
      targetAdsetId: "target_adset_1",
      dryRun: false,
      requestedBy: "user_1",
      payloadRequest: {
        dry_run: false,
        body: { target_adset_id: "target_adset_1" },
      },
      recIdOrigin: null,
      marker: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      canonicalAdName:
        "Duplicate [ADSECUTE_DUP:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]",
      sinceMinutes: 10,
    });

    expect(result).toMatchObject({
      claimed: true,
      log: {
        id: "duplicate_claim_1",
        providerAccountId: "act_123",
        status: "pending",
      },
    });
    expect(db.runDbTransaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      LOCK_DECISION_ORIGIN_AD_ACTION_CLAIM_QUERY,
      [
        JSON.stringify([
          "duplicate",
          "business_1",
          "act_123",
          "source_ad_1",
          "target_adset_1",
        ]),
      ],
    );
    expect(sql).toHaveBeenCalledTimes(2);
    expect(sql.mock.calls[0]).toContain("act_123");
    expect(sql.mock.calls[1]).toContain("act_123");
    expect(
      duplicateStore.prepareMetaAdDuplicateAttempt,
    ).toHaveBeenCalledTimes(1);
  });

  it("keeps an old non-dry pending duplicate reconciliation-blocking and inserts no second claim", async () => {
    const unresolved = decisionLogRow({
      id: "old_pending_duplicate",
      source: "manual_operator_v1",
      action: "duplicate",
      status: "pending",
      provider_account_ref_id: null,
      provider_account_id: "act_123",
      decision_contract_version: null,
      decision_episode_key: null,
      decision_snapshot_id: null,
      decision_evaluation_id: null,
      decision_engine_version: null,
      decision_hash: null,
      idempotency_key: null,
      dry_run: false,
      requested_at: "2026-07-01T00:00:00.000Z",
      payload_request: {
        dry_run: false,
        body: { target_adset_id: "target_adset_1" },
      },
      verified_at: null,
      provider_verified: false,
      terminal_finalized_at: null,
    });
    const query = vi.fn().mockResolvedValue([]);
    const sql = vi.fn().mockResolvedValueOnce([unresolved]);
    Object.assign(sql, { query });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await claimMetaAdDuplicateAction({
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "source_ad_1",
      creativeId: "creative_1",
      targetAdsetId: "target_adset_1",
      dryRun: false,
      requestedBy: "user_1",
      payloadRequest: {
        dry_run: false,
        body: { target_adset_id: "target_adset_1" },
      },
      recIdOrigin: null,
      marker: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      canonicalAdName:
        "Duplicate [ADSECUTE_DUP:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]",
      sinceMinutes: 10,
    });

    expect(result).toMatchObject({
      claimed: false,
      existing: { id: "old_pending_duplicate", status: "pending" },
    });
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("returns only successful Launchpad-created ad ids for resume scope", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      { resulting_ad_id: "ad_1" },
      { resulting_ad_id: "ad_2" },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await readLaunchpadCreatedAdIds({
      businessId: "business_1",
      adIds: ["ad_1", "ad_2", "ad_3", "ad_2"],
    });

    expect(result).toEqual(new Set(["ad_1", "ad_2"]));
    const querySql = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(querySql).toContain("action IN ('launch_ad', 'duplicate')");
    expect(querySql).toContain("status = 'success'");
    expect(sql.mock.calls[0]?.slice(1)).toEqual([
      "business_1",
      ["ad_1", "ad_2", "ad_3"],
    ]);
  });

  it("reads a source only through exact native snapshot/evaluation linkage", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      {
        business_id: "business_1",
        provider_account_id: "act_123",
        decision_entity_type: "ad",
        decision_entity_id: "123456789012345",
        ad_id: "123456789012345",
        campaign_id: "campaign_1",
        adset_id: "adset_1",
        creative_id: "shared_creative",
        snapshot_id: "snapshot_1",
        evaluation_id: "evaluation_1",
        engine_version: NATIVE_AD_ENGINE_VERSION,
        decision_hash: DECISION_HASH,
        decision_label: "cut",
        blocked_action_type: null,
        native_authorized_action: "cut",
        computed_at: "2026-07-12T09:30:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const source = await readDecisionOriginSourceDecision({
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
    });

    expect(source).toMatchObject({
      found: true,
      providerAccountId: "act_123",
      decisionEntityType: "ad",
      decisionEntityId: "123456789012345",
      adId: "123456789012345",
      campaignId: "campaign_1",
      adsetId: "adset_1",
      creativeId: "shared_creative",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
      decisionHash: DECISION_HASH,
      decisionLabel: "cut",
      explicitAuthorizedAction: "pause",
    });
    const querySql = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(querySql).toContain("engine_v3_ad_decision_snapshots_daily");
    expect(querySql).toContain("engine_v3_ad_decision_evaluations");
    expect(querySql).toContain("evaluation.id = snapshot.evaluation_id");
    expect(querySql).toContain("evaluation.decision_hash = snapshot.decision_hash");
    expect(querySql).toContain(
      "snapshot.authorized_action AS native_authorized_action",
    );
    expect(querySql).toContain(
      "evaluation.creative_input_json->>'campaignId' AS campaign_id",
    );
    expect(querySql).toContain(
      "evaluation.creative_input_json->>'adsetId' AS adset_id",
    );
    expect(querySql).not.toContain("authorizedAdAction");
    expect(querySql).toContain("snapshot.id =");
    expect(querySql).toContain("evaluation.id =");
  });

  it("maps native decision authorization to provider status actions explicitly", () => {
    expect(providerActionForNativeAuthorization("cut")).toBe("pause");
    expect(providerActionForNativeAuthorization("scale")).toBe("resume");
    expect(providerActionForNativeAuthorization("refresh")).toBeNull();
    expect(providerActionForNativeAuthorization("pause")).toBeNull();
  });

  it("persists exact decision lineage and idempotency in the action payload", async () => {
    const { sql, query } = decisionOriginCreateSqlMock({
      insertedRows: [
        decisionLogRow({
          status: "pending",
          verified_at: null,
          verification_payload: null,
          provider_verified: false,
          verification_entity_id: null,
          verification_status: null,
          terminal_finalized_at: null,
        }),
      ],
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const row = await createDecisionOriginMetaAdsActionLog({
      request: decisionRequest(),
      requestedBy: "user_1",
      payloadRequest: { endpoint: "/ad_1", body: { status: "PAUSED" } },
    });

    expect(row).toMatchObject({
      businessId: "business_1",
      adId: "123456789012345",
      creativeId: "creative_1",
      providerAccountId: "act_123",
      idempotencyKey: CANONICAL_DECISION_KEY,
      dryRun: false,
      providerVerified: false,
      treatmentEligible: false,
      decisionOrigin: {
        snapshotId: "snapshot_1",
        evaluationId: "evaluation_1",
        engineVersion: NATIVE_AD_ENGINE_VERSION,
        decisionHash: DECISION_HASH,
      },
    });
    expect(query).toHaveBeenCalledWith(
      CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY,
      expect.any(Array),
    );
    expect(CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY).toContain(
      "snapshot.authorized_action = CASE $8",
    );
    expect(CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY).toContain(
      "WHEN 'pause' THEN 'cut'",
    );
    expect(CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY).toContain(
      "WHEN 'resume' THEN 'scale'",
    );
    expect(CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY).not.toContain(
      "authorizedAdAction",
    );
    expect(CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY).toContain(
      "ON CONFLICT (business_id, idempotency_key)",
    );
    const createCall = query.mock.calls.find(
      ([queryText]) =>
        queryText === CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY,
    );
    const params = createCall?.[1] as unknown[];
    const payloadJson = params[9];
    expect(JSON.parse(String(payloadJson))).toMatchObject({
      contract_version: "meta-decision-origin-ad-execution.v1",
      execution_origin: "decision_origin",
      provider_account_id: "act_123",
      source_snapshot_id: "snapshot_1",
      source_evaluation_id: "evaluation_1",
      engine_version: NATIVE_AD_ENGINE_VERSION,
      decision_hash: DECISION_HASH,
      idempotency_key: CANONICAL_DECISION_KEY,
      dry_run: false,
    });
  });

  it("returns the exact existing log when the idempotency insert races", async () => {
    const { sql, query } = decisionOriginCreateSqlMock({
      insertedRows: [],
      existingRows: [decisionLogRow()],
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const row = await createDecisionOriginMetaAdsActionLog({
      request: decisionRequest(),
      requestedBy: "user_1",
      payloadRequest: { endpoint: "/ad_1", body: { status: "PAUSED" } },
    });

    expect(row).toMatchObject({
      id: "log_1",
      status: "success",
      idempotencyKey: CANONICAL_DECISION_KEY,
      idempotentReplay: true,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("rejects an idempotency retry with conflicting action lineage", async () => {
    const { sql } = decisionOriginCreateSqlMock({
      insertedRows: [],
      existingRows: [decisionLogRow({ ad_id: "different_ad" })],
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      createDecisionOriginMetaAdsActionLog({
        request: decisionRequest(),
        requestedBy: "user_1",
      }),
    ).rejects.toThrow("idempotency key conflicts");
  });

  it("rejects an idempotency retry with conflicting creative identity", async () => {
    const { sql } = decisionOriginCreateSqlMock({
      insertedRows: [],
      existingRows: [decisionLogRow({ creative_id: "creative_other" })],
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      createDecisionOriginMetaAdsActionLog({
        request: decisionRequest(),
        requestedBy: "user_1",
      }),
    ).rejects.toThrow("idempotency key conflicts");
  });

  it("serializes a different-key exact-Ad claim behind the unresolved pending row", async () => {
    const { sql, query } = decisionOriginCreateSqlMock({
      insertedRows: [],
      pendingRows: [
        decisionLogRow({
          status: "pending",
          idempotency_key: "different-canonical-key",
          verified_at: null,
          provider_verified: false,
          terminal_finalized_at: null,
        }),
      ],
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      createDecisionOriginMetaAdsActionLog({
        request: decisionRequest(),
        requestedBy: "user_1",
      }),
    ).rejects.toThrow("decision_origin_pending_reconciliation_required");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      LOCK_DECISION_ORIGIN_AD_ACTION_CLAIM_QUERY,
      [JSON.stringify(["business_1", "act_123", "123456789012345"])],
    );
    expect(query).not.toHaveBeenCalledWith(
      CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY,
      expect.anything(),
    );
  });

  it("locks, verifies, updates and inserts the mandatory receipt in one transaction", async () => {
    let terminalRow = lockedDecisionLogRow({
      status: "pending",
      verified_at: null,
      provider_verified: false,
      verification_entity_id: null,
      verification_status: null,
      terminal_finalized_at: null,
    });
    let receipt: Record<string, string> | null = null;
    const query = vi.fn(async (queryText: string, params?: unknown[]) => {
      if (queryText === LOCK_DECISION_ORIGIN_ACTION_FOR_FINALIZATION_QUERY) {
        return [
          {
            ...terminalRow,
            existing_receipt_id: receipt?.receipt_id ?? null,
            existing_receipt_hash: receipt?.receipt_hash ?? null,
            existing_receipt_captured_at: receipt
              ? "2026-07-12T10:00:01.000Z"
              : null,
          },
        ];
      }
      if (queryText === UPDATE_DECISION_ORIGIN_ACTION_TERMINAL_QUERY) {
        expect(params?.[1]).toBe("success");
        expect(params?.[6]).toBe(true);
        terminalRow = lockedDecisionLogRow({
          status: "success",
          verified_at: "2026-07-12T10:00:01.000Z",
          provider_verified: true,
          verification_entity_id: "123456789012345",
          verification_status: "PAUSED",
          verification_payload: JSON.parse(String(params?.[8])),
          terminal_finalized_at: "2026-07-12T10:00:01.000Z",
        });
        return [terminalRow];
      }
      if (queryText === INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY) {
        const payload = JSON.parse(String(params?.[0])) as Record<
          string,
          unknown
        >;
        expect(payload).toMatchObject({
          source_action_log_id: "log_1",
          business_ref_id: "business_1",
          provider_account_ref_id: "provider_ref_1",
          provider_account_id: "act_123",
          source_ad_id: "123456789012345",
          source_snapshot_id: "snapshot_1",
          source_evaluation_id: "evaluation_1",
          source_engine_version: NATIVE_AD_ENGINE_VERSION,
          source_decision_hash: DECISION_HASH,
          operator_action: "pause",
          action_status: "success",
          provider_verified: true,
          verification_lineage: {
            sourceCreativeId: "creative_1",
            sourceCampaignId: "campaign_1",
            sourceAdsetId: "adset_1",
            verifiedProviderAccountId: "act_123",
            verifiedCreativeId: "creative_1",
            verifiedCampaignId: "campaign_1",
            verifiedAdsetId: "adset_1",
          },
        });
        receipt = {
          receipt_id: String(payload.id),
          action_log_id: String(payload.source_action_log_id),
          receipt_hash: String(payload.receipt_hash),
        };
        return [receipt];
      }
      throw new Error(`Unexpected query: ${queryText}`);
    });
    const sql = vi.fn();
    Object.assign(sql, { query });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const row = await completeDecisionOriginMetaAdsActionLog({
      id: "log_1",
      status: "success",
      payloadResponse: { success: true },
      providerCompletedAt: "2026-07-12T10:00:00.000Z",
      verificationPayload: {
        contractVersion: "meta-ad-status-write-verification.v1",
        adId: "123456789012345",
        providerAccountId: "act_123",
        creativeId: "creative_1",
        campaignId: "campaign_1",
        adsetId: "adset_1",
        configuredStatus: "PAUSED",
        effectiveStatus: "PAUSED",
        campaignConfiguredStatus: "ACTIVE",
        campaignEffectiveStatus: "ACTIVE",
        adsetConfiguredStatus: "ACTIVE",
        adsetEffectiveStatus: "ACTIVE",
        policyEligible: true,
        reviewStatus: null,
        observedAt: "2026-07-12T10:00:00.500Z",
        providerGetEvidence: {
          id: "123456789012345",
          account_id: "123",
          status: "PAUSED",
          effective_status: "PAUSED",
          creative: { id: "creative_1" },
          campaign: {
            id: "campaign_1",
            status: "ACTIVE",
            effective_status: "ACTIVE",
          },
          adset: {
            id: "adset_1",
            status: "ACTIVE",
            effective_status: "ACTIVE",
          },
        },
      },
    });

    expect(row.providerVerified).toBe(true);
    expect(row.treatmentEligible).toBe(true);
    expect(receipt).not.toBeNull();
    expect(vi.mocked(db.runDbTransaction)).toHaveBeenCalledTimes(1);
  });

  it("rejects a pre-existing terminal decision-origin row without its receipt", async () => {
    const { sql, query } = queryableSqlMock([
      lockedDecisionLogRow({
        existing_receipt_id: null,
        existing_receipt_hash: null,
      }),
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      completeDecisionOriginMetaAdsActionLog({
        id: "log_1",
        status: "success",
        verificationPayload: {
          id: "123456789012345",
          status: "PAUSED",
        },
      }),
    ).rejects.toThrow(/terminal without its mandatory immutable receipt/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns the exact prior receipt for inert duplicate retries", async () => {
    const sql = vi.fn().mockResolvedValueOnce([decisionLogRow()]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const receipt = await findDecisionOriginActionByIdempotency({
      businessId: "business_1",
      idempotencyKey: CANONICAL_DECISION_KEY,
    });

    expect(receipt).toEqual({
      actionLogId: "log_1",
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "123456789012345",
      creativeId: "creative_1",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      decisionHash: DECISION_HASH,
      action: "pause",
      idempotencyKey: CANONICAL_DECISION_KEY,
      status: "success",
      dryRun: false,
      providerVerified: true,
      treatmentEligible: true,
      errorCode: null,
      reconciliationRequired: false,
      retryAllowed: null,
    });
    const querySql = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(querySql).toContain("source = 'decision_origin'");
    expect(querySql).toContain("idempotency_key");
    expect(querySql).toContain(
      "receipt.contract_version = action_log.decision_contract_version",
    );
    expect(querySql).toContain(
      "receipt.action_status = action_log.status",
    );
    expect(querySql).toContain(
      "receipt.provider_verified = action_log.provider_verified",
    );
    expect(querySql).toContain(
      "receipt.verification_lineage = jsonb_build_object",
    );
    expect(querySql).toContain("snapshot.id::text AS authority_snapshot_id");
    expect(querySql).toContain(
      "evaluation.id::text AS authority_evaluation_id",
    );
  });

  it("fails closed when a terminal receipt hash does not match DB-derived authority", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      decisionLogRow({ existing_receipt_hash: "f".repeat(64) }),
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const receipt = await findDecisionOriginActionByIdempotency({
      businessId: "business_1",
      idempotencyKey: CANONICAL_DECISION_KEY,
    });

    expect(receipt).toMatchObject({
      status: "success",
      providerVerified: true,
      treatmentEligible: false,
    });
  });

  it("fails closed without exact episode, snapshot, evaluation and receipt authority", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      decisionLogRow({
        episode_business_id: null,
        authority_snapshot_id: null,
        authority_evaluation_id: null,
        existing_receipt_captured_at: null,
      }),
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const receipt = await findDecisionOriginActionByIdempotency({
      businessId: "business_1",
      idempotencyKey: CANONICAL_DECISION_KEY,
    });

    expect(receipt).toMatchObject({
      status: "success",
      providerVerified: true,
      treatmentEligible: false,
    });
  });

  it("durably marks a verified provider write that still needs exact receipt reconciliation", async () => {
    const observedAt = "2026-07-12T10:00:02.000Z";
    const providerCompletedAt = "2026-07-12T10:00:00.000Z";
    const verificationPayload = {
      contractVersion: "meta-ad-status-write-verification.v1",
      adId: "123456789012345",
      providerAccountId: "act_123",
      creativeId: "creative_1",
      campaignId: "campaign_1",
      adsetId: "adset_1",
      configuredStatus: "PAUSED",
      effectiveStatus: "PAUSED",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-12T10:00:01.000Z",
      providerGetEvidence: {
        id: "123456789012345",
        account_id: "123",
        status: "PAUSED",
        effective_status: "PAUSED",
        creative: { id: "creative_1" },
        campaign: {
          id: "campaign_1",
          status: "ACTIVE",
          effective_status: "ACTIVE",
        },
        adset: {
          id: "adset_1",
          status: "ACTIVE",
          effective_status: "ACTIVE",
        },
      },
    };
    const persistedVerificationPayload = {
      ...verificationPayload,
      providerCompletedAt,
    };
    const pendingRow = decisionLogRow({
      status: "pending",
      payload_response: {
        decision_origin_reconciliation: {
          reconciliation_required: true,
          retry_allowed: false,
          outcome:
            "provider_write_verified_receipt_persistence_failed",
          provider_mutation_attempted: true,
          provider_mutation_succeeded: true,
          provider_outcome_ambiguous: false,
          provider_error_code: null,
          mutation_attempt: null,
          provider_response_payload: null,
          verification_payload_captured: true,
          observed_at: observedAt,
        },
      },
      error_code: "provider_verification_persistence_failed",
      error_message: "receipt insert failed",
      verified_at: null,
      provider_verified: false,
      verification_entity_id: null,
      verification_status: null,
      terminal_finalized_at: null,
    });
    const { sql, query } = queryableSqlMock([pendingRow]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const row = await markDecisionOriginActionReconciliationRequired({
      id: "log_1",
      errorMessage: "receipt insert failed",
      durationMs: 150,
      verificationPayload,
      providerCompletedAt,
      observedAt,
    });

    expect(query).toHaveBeenCalledWith(
      MARK_DECISION_ORIGIN_RECONCILIATION_REQUIRED_QUERY,
      [
        "log_1",
        JSON.stringify({
          reconciliation_required: true,
          retry_allowed: false,
          outcome:
            "provider_write_verified_receipt_persistence_failed",
          provider_mutation_attempted: true,
          provider_mutation_succeeded: true,
          provider_outcome_ambiguous: false,
          provider_error_code: null,
          mutation_attempt: null,
          provider_response_payload: null,
          verification_payload_captured: true,
          observed_at: observedAt,
        }),
        "receipt insert failed",
        150,
        JSON.stringify(persistedVerificationPayload),
        observedAt,
      ],
    );
    expect(row).toMatchObject({
      id: "log_1",
      status: "pending",
      errorCode: "provider_verification_persistence_failed",
      providerVerified: false,
      terminalFinalizedAt: null,
    });
  });

  it("presents a pending reconciliation marker as non-retryable idempotency evidence", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      decisionLogRow({
        status: "pending",
        payload_response: {
          decision_origin_reconciliation: {
            reconciliation_required: true,
            retry_allowed: false,
            provider_mutation_succeeded: true,
          },
        },
        error_code: "provider_verification_persistence_failed",
        error_message: "receipt insert failed",
        verified_at: null,
        provider_verified: false,
        terminal_finalized_at: null,
      }),
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const receipt = await findDecisionOriginActionByIdempotency({
      businessId: "business_1",
      idempotencyKey: CANONICAL_DECISION_KEY,
    });

    expect(receipt).toMatchObject({
      status: "pending",
      errorCode: "provider_verification_persistence_failed",
      reconciliationRequired: true,
      retryAllowed: false,
      providerVerified: false,
      treatmentEligible: false,
    });
  });

  it("quarantines every unresolved decision-origin pending row without a TTL", async () => {
    const sql = vi.fn().mockResolvedValueOnce([
      decisionLogRow({
        status: "pending",
        error_code: null,
        error_message: null,
        verified_at: null,
        provider_verified: false,
        terminal_finalized_at: null,
        requested_at: "2026-07-10T00:00:00.000Z",
      }),
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const receipt = await findUnresolvedDecisionOriginPendingAction({
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "123456789012345",
    });

    const queryText = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(queryText).toContain("source = 'decision_origin'");
    expect(queryText).toContain("status = 'pending'");
    expect(queryText).toContain("terminal_finalized_at IS NULL");
    expect(queryText).not.toContain("interval");
    expect(queryText).not.toContain("requested_at >");
    expect(receipt).toMatchObject({
      actionLogId: "log_1",
      status: "pending",
      providerVerified: false,
      reconciliationRequired: false,
    });
  });

  it("reads a settled pre-provider manual reconciliation candidate without network access", async () => {
    const source = manualReconciliationCandidateSource();
    const query = vi.fn(async (queryText: string) => {
      if (
        queryText ===
        READ_MANUAL_META_AD_STATUS_RECONCILIATION_CANDIDATE_QUERY
      ) {
        return [source];
      }
      if (queryText === READ_MANUAL_META_AD_STATUS_MUTATION_ATTEMPTS_QUERY) {
        return [];
      }
      throw new Error(`Unexpected query: ${queryText}`);
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const result = await readManualMetaAdStatusReconciliationCandidate({
      businessId: source.business_id,
      providerAccountId: source.provider_account_id,
      adId: source.ad_id,
    });

    expect(result).toEqual({
      businessId: source.business_id,
      providerAccountId: source.provider_account_id,
      adId: source.ad_id,
      unresolvedSourceCount: 1,
      sourceActionLogId: source.id,
      action: "pause",
      creativeId: "creative_1",
      readyForProviderRead: true,
      settlementNotBefore: "2026-07-19T10:05:00.000Z",
      authorityKind: "pre_provider_no_attempt",
      outcome: "pre_provider_no_mutation_attempt",
      providerAccountRefId:
        "33333333-3333-4333-8333-333333333333",
      campaignId: "campaign_1",
      adsetId: "adset_1",
      blockerReason: null,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(
      READ_MANUAL_META_AD_STATUS_RECONCILIATION_CANDIDATE_QUERY,
    ).toContain("LEFT JOIN LATERAL");
    expect(
      READ_MANUAL_META_AD_STATUS_RECONCILIATION_CANDIDATE_QUERY,
    ).toContain("count(*)::integer AS binding_count");
    expect(
      READ_MANUAL_META_AD_STATUS_RECONCILIATION_CANDIDATE_QUERY,
    ).toContain("action_log.source <> 'decision_origin'");
  });

  it("does not authorize a provider GET before the fixed settlement floor", async () => {
    const source = manualReconciliationCandidateSource({
      db_now: "2026-07-19T10:04:59.999Z",
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    await expect(
      readManualMetaAdStatusReconciliationCandidate({
        businessId: source.business_id,
        providerAccountId: source.provider_account_id,
        adId: source.ad_id,
      }),
    ).resolves.toMatchObject({
      readyForProviderRead: false,
      settlementNotBefore: "2026-07-19T10:05:00.000Z",
      blockerReason: "settlement_not_elapsed",
    });
  });

  it("fails closed before provider read when unresolved manual sources are contradictory", async () => {
    const source = manualReconciliationCandidateSource({
      unresolved_source_count: 2,
    });
    const query = vi.fn().mockResolvedValueOnce([source]);
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    await expect(
      readManualMetaAdStatusReconciliationCandidate({
        businessId: source.business_id,
        providerAccountId: source.provider_account_id,
        adId: source.ad_id,
      }),
    ).resolves.toMatchObject({
      unresolvedSourceCount: 2,
      readyForProviderRead: false,
      blockerReason: "multiple_unresolved_manual_sources",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("fails closed on duplicate physical bindings without inflating source count", async () => {
    const source = manualReconciliationCandidateSource({
      bound_provider_account_count: 2,
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    await expect(
      readManualMetaAdStatusReconciliationCandidate({
        businessId: source.business_id,
        providerAccountId: source.provider_account_id,
        adId: source.ad_id,
      }),
    ).resolves.toMatchObject({
      unresolvedSourceCount: 1,
      readyForProviderRead: false,
      blockerReason: "provider_binding_missing",
    });
  });

  it("rejects an attempt start whose durable source target does not match the provider hierarchy", async () => {
    const source = manualReconciliationCandidateSource({
      payload_request: {
        mutation_journal_contract_version:
          MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
        mutation_journal_required: true,
        manual_status_mutation_target: {
          businessId: "22222222-2222-4222-8222-222222222222",
          providerAccountId: "act_123",
          adId: "123456789012345",
          creativeId: "creative_1",
          campaignId: "different_campaign",
          adsetId: "adset_1",
        },
      },
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([source]);
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    await expect(
      appendManualMetaAdStatusMutationAttemptStarted({
        sourceActionLogId: source.id,
        target: {
          businessId: source.business_id,
          providerAccountId: source.provider_account_id,
          adId: source.ad_id,
          creativeId: source.creative_id,
          campaignId: "campaign_1",
          adsetId: "adset_1",
        },
        action: "pause",
        postPath: source.ad_id,
      }),
    ).rejects.toThrow(
      "Manual Meta mutation attempt start source lineage is not exact.",
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects a 2xx definite-failure completion without an exact provider error body", async () => {
    const source = manualReconciliationCandidateSource({
      db_now: "2026-07-19T10:01:00.000Z",
    });
    const started = manualMutationAttemptStartedDbRow();
    const query = vi
      .fn()
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([started]);
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    await expect(
      appendManualMetaAdStatusMutationAttemptCompleted({
        sourceActionLogId: source.id,
        attemptId: started.attempt_id,
        completionOutcome: "provider_definite_failure",
        mutationAttempt: {
          attemptCount: 1,
          method: "POST",
          path: started.post_path,
          attemptedAt: "2026-07-19T10:01:00.000Z",
          completedAt: "2026-07-19T10:01:00.000Z",
          providerResponseReceived: true,
          providerResponseSuccessful: false,
          httpStatus: 200,
          outcome: "provider_response_received",
          automaticRetryAttempted: false,
          transportError: null,
        },
        providerResponse: { success: false },
        verification: null,
      }),
    ).rejects.toThrow(
      "Manual Meta definite-failure mutation completion geometry is invalid.",
    );
    expect(query).toHaveBeenCalledTimes(4);
  });
});
