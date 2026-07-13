import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionOriginAdExecutionRequest } from "@/lib/creative-decision-engine/execution-safety";
import { buildAdRecommendationEpisode } from "@/lib/creative-decision-engine/ad-operator-response-detection";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const db = await import("@/lib/db");
const {
  CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY,
  INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY,
  LOCK_DECISION_ORIGIN_ACTION_FOR_FINALIZATION_QUERY,
  UPDATE_DECISION_ORIGIN_ACTION_TERMINAL_QUERY,
  completeDecisionOriginMetaAdsActionLog,
  createDecisionOriginMetaAdsActionLog,
  createMetaAdsActionLog,
  findDecisionOriginActionByIdempotency,
  findRecentDuplicateActionResult,
  readDecisionOriginSourceDecision,
  readLaunchpadCreatedAdIds,
  resolveExactMetaAdActionTarget,
  resolveManualMetaAdActionTarget,
  resolveMetaAdActionTarget,
} = await import("./ads-action-log");

const DECISION_HASH = "d".repeat(64);
const NATIVE_EPISODE = buildAdRecommendationEpisode({
  businessId: "business_1",
  businessDisplayId: "business_1",
  providerAccountRefId: "provider_ref_1",
  providerAccountId: "act_123",
  adId: "ad_1",
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

function decisionRequest(
  overrides: Partial<DecisionOriginAdExecutionRequest> = {},
): DecisionOriginAdExecutionRequest {
  return {
    contractVersion: "meta-decision-origin-ad-execution.v1" as const,
    businessId: "business_1",
    providerAccountId: "act_123",
    adId: "ad_1",
    snapshotId: "snapshot_1",
    evaluationId: "evaluation_1",
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    decisionHash: DECISION_HASH,
    action: "pause",
    idempotencyKey: "decision-action-1",
    creativeId: "creative_1",
    ...overrides,
  };
}

function decisionLogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "log_1",
    business_id: "business_1",
    ad_id: "ad_1",
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
      idempotency_key: "decision-action-1",
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
      id: "ad_1",
      status: "PAUSED",
      effective_status: "PAUSED",
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
    idempotency_key: "decision-action-1",
    dry_run: false,
    provider_verified: true,
    verification_entity_id: "ad_1",
    verification_status: "PAUSED",
    terminal_finalized_at: "2026-07-12T10:00:01.000Z",
    created_at: "2026-07-12T10:00:00.000Z",
    updated_at: "2026-07-12T10:00:01.000Z",
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
          ad_id: "ad_1",
          creative_id: "shared_creative",
        },
      ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await resolveExactMetaAdActionTarget({
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "ad_1",
    });

    expect(result).toEqual({
      ok: true,
      target: {
        businessId: "business_1",
        providerAccountId: "act_123",
        adId: "ad_1",
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
        adId: "wrong_ad",
      }),
    ).resolves.toEqual({ ok: false, reason: "ad_not_found" });
    expect(sql).toHaveBeenCalledTimes(2);
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
      adId: "source_ad_1",
      targetAdsetId: "target_adset_1",
      sinceMinutes: 10,
    });

    expect(result?.resultingAdId).toBe("duplicate_ad_1");
    const querySql = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(querySql).toContain("AND ad_id =");
    expect(querySql).toContain("target_adset_id");
    expect(querySql).not.toContain("status_option");
    expect(sql.mock.calls[0]?.slice(1)).toEqual([
      "business_1",
      "source_ad_1",
      "target_adset_1",
      10,
    ]);
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
        decision_entity_id: "ad_1",
        ad_id: "ad_1",
        creative_id: "shared_creative",
        snapshot_id: "snapshot_1",
        evaluation_id: "evaluation_1",
        engine_version: NATIVE_AD_ENGINE_VERSION,
        decision_hash: DECISION_HASH,
        decision_label: "cut",
        blocked_action_type: null,
        explicit_authorized_action: "pause",
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
      decisionEntityId: "ad_1",
      adId: "ad_1",
      creativeId: "shared_creative",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
      decisionHash: DECISION_HASH,
      decisionLabel: "cut",
    });
    const querySql = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(querySql).toContain("engine_v3_ad_decision_snapshots_daily");
    expect(querySql).toContain("engine_v3_ad_decision_evaluations");
    expect(querySql).toContain("evaluation.id = snapshot.evaluation_id");
    expect(querySql).toContain("evaluation.decision_hash = snapshot.decision_hash");
    expect(querySql).toContain("snapshot.id =");
    expect(querySql).toContain("evaluation.id =");
  });

  it("persists exact decision lineage and idempotency in the action payload", async () => {
    const { sql, query } = queryableSqlMock([
      decisionLogRow({
        status: "pending",
        verified_at: null,
        verification_payload: null,
        provider_verified: false,
        verification_entity_id: null,
        verification_status: null,
        terminal_finalized_at: null,
      }),
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const row = await createDecisionOriginMetaAdsActionLog({
      request: decisionRequest(),
      requestedBy: "user_1",
      payloadRequest: { endpoint: "/ad_1", body: { status: "PAUSED" } },
    });

    expect(row).toMatchObject({
      businessId: "business_1",
      adId: "ad_1",
      providerAccountId: "act_123",
      idempotencyKey: "decision-action-1",
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
    const params = query.mock.calls[0]?.[1] as unknown[];
    const payloadJson = params[9];
    expect(JSON.parse(String(payloadJson))).toMatchObject({
      contract_version: "meta-decision-origin-ad-execution.v1",
      execution_origin: "decision_origin",
      provider_account_id: "act_123",
      source_snapshot_id: "snapshot_1",
      source_evaluation_id: "evaluation_1",
      engine_version: NATIVE_AD_ENGINE_VERSION,
      decision_hash: DECISION_HASH,
      idempotency_key: "decision-action-1",
      dry_run: false,
    });
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
          verification_entity_id: "ad_1",
          verification_status: "PAUSED",
          terminal_finalized_at: "2026-07-12T10:00:01.000Z",
        });
        return [terminalRow];
      }
      if (queryText === INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY) {
        const payload = JSON.parse(String(params?.[0])) as Record<string, string>;
        expect(payload).toMatchObject({
          source_action_log_id: "log_1",
          business_ref_id: "business_1",
          provider_account_ref_id: "provider_ref_1",
          provider_account_id: "act_123",
          source_ad_id: "ad_1",
          source_snapshot_id: "snapshot_1",
          source_evaluation_id: "evaluation_1",
          source_engine_version: NATIVE_AD_ENGINE_VERSION,
          source_decision_hash: DECISION_HASH,
          operator_action: "pause",
          action_status: "success",
          provider_verified: true,
        });
        receipt = {
          receipt_id: payload.id,
          action_log_id: payload.source_action_log_id,
          receipt_hash: payload.receipt_hash,
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
      verificationPayload: {
        id: "ad_1",
        status: "PAUSED",
        effective_status: "PAUSED",
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
        verificationPayload: { id: "ad_1", status: "PAUSED" },
      }),
    ).rejects.toThrow(/terminal without its mandatory immutable receipt/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns the exact prior receipt for inert duplicate retries", async () => {
    const sql = vi.fn().mockResolvedValueOnce([decisionLogRow()]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const receipt = await findDecisionOriginActionByIdempotency({
      businessId: "business_1",
      idempotencyKey: "decision-action-1",
    });

    expect(receipt).toEqual({
      actionLogId: "log_1",
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "ad_1",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      decisionHash: DECISION_HASH,
      action: "pause",
      idempotencyKey: "decision-action-1",
      status: "success",
      dryRun: false,
      providerVerified: true,
      treatmentEligible: true,
    });
    const querySql = String(sql.mock.calls[0]?.[0]?.join(""));
    expect(querySql).toContain("source = 'decision_origin'");
    expect(querySql).toContain("idempotency_key");
  });
});
