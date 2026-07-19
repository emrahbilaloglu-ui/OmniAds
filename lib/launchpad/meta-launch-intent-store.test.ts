import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/launchpad/meta-launch-intent-lineage", () => ({
  verifyMetaLaunchIntentLineage: vi.fn(),
}));

const store = await import("@/lib/launchpad/meta-launch-intent-store");
const lineage = await import("@/lib/launchpad/meta-launch-intent-lineage");
const {
  buildMetaLaunchIntentResultReceipt,
  buildMetaLaunchIntentValidationReceipt,
} = await import("@/lib/launchpad/meta-launch-intent");

const row = {
  id: "intent_1",
  business_id: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  provider_account_id: "act_123",
  operation: "new_campaign",
  idempotency_key: "idem_1",
  requested_status: "PAUSED",
  source_decision_id: "decision_1",
  source_decision_snapshot_id: null,
  creative_brief_id: "brief_1",
  source_draft_id: null,
  request_payload_json: { campaign: { name: "Launch" } },
  request_fingerprint: "fingerprint",
  status: "prepared",
  validation_receipt_json: null,
  result_receipt_json: null,
  error_receipt_json: null,
  created_by: "272d0ab8-495b-4679-a4c6-ffa404c389d3",
  created_at: "2026-07-10T12:00:00.000Z",
  updated_at: "2026-07-10T12:00:00.000Z",
  started_at: null,
  completed_at: null,
};

describe("Meta LaunchIntent store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(lineage.verifyMetaLaunchIntentLineage).mockImplementation(
      async (input) => ({
        sourceDecisionId: input.sourceDecisionId?.trim() || null,
        sourceDecisionSnapshotId:
          input.sourceDecisionSnapshotId?.trim() || null,
        creativeBriefId: input.creativeBriefId?.trim() || null,
        sourceDraftId: input.sourceDraftId?.trim() || null,
      }),
    );
  });

  it("persists PAUSED-only account scope, lineage, and idempotency uniqueness", async () => {
    sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row]);

    const result = await store.createMetaLaunchIntent({
      businessId: row.business_id,
      providerAccountId: "act_123",
      operation: "new_campaign",
      idempotencyKey: "idem_1",
      requestPayload: row.request_payload_json,
      sourceDecisionId: "decision_1",
      creativeBriefId: "brief_1",
      createdBy: row.created_by,
    });

    const query = String(sql.mock.calls[2]?.[0]?.join(" ") ?? "");
    expect(result).toMatchObject({
      created: true,
      intent: {
        providerAccountId: "act_123",
        requestedStatus: "PAUSED",
        lineage: {
          sourceDecisionId: "decision_1",
          creativeBriefId: "brief_1",
        },
      },
    });
    expect(query).toContain("ON CONFLICT (business_id, provider_account_id, operation, idempotency_key)");
    expect(query).toContain("requested_status");
  });

  it("blocks an unresolved semantic ambiguity before a fresh-key insert", async () => {
    const ambiguousRow = {
      ...row,
      id: "intent_ambiguous",
      idempotency_key: "old-key",
      status: "silent_failure",
      error_receipt_json: {
        code: "provider_outcome_ambiguous",
        message: "Unknown provider outcome.",
        partialResult: {
          campaignId: null,
          adsetIds: [],
          adIds: [],
          steps: [],
        },
      },
    };
    sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([ambiguousRow]);

    await expect(
      store.createMetaLaunchIntent({
        businessId: row.business_id,
        providerAccountId: "act_123",
        operation: "new_campaign",
        idempotencyKey: "fresh-key",
        requestPayload: row.request_payload_json,
        sourceDecisionId: "decision_1",
        creativeBriefId: "brief_1",
        createdBy: row.created_by,
      }),
    ).rejects.toMatchObject({
      code: "launch_intent_provider_outcome_ambiguous",
      intent: { id: "intent_ambiguous" },
    });

    const queries = sql.mock.calls.map((call) =>
      String(call[0]?.join(" ") ?? ""),
    );
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("pg_advisory_xact_lock");
    expect(queries[1]).toContain("request_fingerprint");
    expect(queries[1]).toContain("status = 'silent_failure'");
    expect(queries[1]).toContain(
      "error_receipt_json->>'code' = 'provider_outcome_ambiguous'",
    );
    expect(queries.some((query) => query.includes("INSERT INTO"))).toBe(false);
  });

  it("allows validation only from prepared and outcome only from executing", async () => {
    const validationReceipt = buildMetaLaunchIntentValidationReceipt({
      providerAccountId: "act_123",
      ok: true,
      blockers: [],
      warnings: [],
    });
    sql.mockResolvedValueOnce([
      { ...row, status: "ready", validation_receipt_json: validationReceipt },
    ]);
    await store.recordMetaLaunchIntentValidation({
      businessId: row.business_id,
      id: row.id,
      receipt: validationReceipt,
    });
    const validationQuery = String(sql.mock.calls[0]?.[0]?.join(" ") ?? "");
    expect(validationQuery).toContain("AND status = 'prepared'");

    sql.mockResolvedValueOnce([
      {
        ...row,
        status: "succeeded",
        result_receipt_json: buildMetaLaunchIntentResultReceipt({
          providerAccountId: "act_123",
        }),
      },
    ]);
    await store.recordMetaLaunchIntentOutcome({
      businessId: row.business_id,
      id: row.id,
      status: "succeeded",
      resultReceipt: buildMetaLaunchIntentResultReceipt({
        providerAccountId: "act_123",
      }),
    });
    const outcomeQuery = String(sql.mock.calls[1]?.[0]?.join(" ") ?? "");
    expect(outcomeQuery).toContain("AND status = 'executing'");
  });
});
