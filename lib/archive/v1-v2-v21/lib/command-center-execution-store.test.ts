import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
  getDbSchemaReadiness: vi.fn().mockResolvedValue({
    ready: true,
    missingTables: [],
    checkedAt: "2026-04-17T00:00:00.000Z",
  }),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `business-ref-${businessId}`] as const),
    );
  }),
}));

const schemaReadiness = await import("@/lib/db-schema-readiness");
const {
  appendCommandCenterExecutionAudit,
  upsertCommandCenterExecutionState,
} = await import("@/lib/command-center-execution-store");

describe("command center execution store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(schemaReadiness.assertDbSchemaReady).mockResolvedValue(undefined as never);
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-17T00:00:00.000Z",
    } as never);
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("SELECT") && query.includes("FROM command_center_action_execution_state")) {
        return [
          {
            business_id: "biz-1",
            action_fingerprint: "action-1",
            execution_status: "pending",
            support_mode: "guided",
            source_system: "meta",
            source_type: "recommendation",
            requested_action: "pause",
            preview_hash: null,
            capability_key: null,
            workflow_status_snapshot: "open",
            approval_actor_user_id: null,
            approval_actor_name: null,
            approval_actor_email: null,
            approved_at: null,
            applied_by_user_id: null,
            applied_by_name: null,
            applied_by_email: null,
            applied_at: null,
            rollback_kind: "not_available",
            rollback_note: null,
            last_client_mutation_id: null,
            last_error_code: null,
            last_error_message: null,
            current_state_json: null,
            requested_state_json: null,
            captured_pre_apply_state_json: null,
            preflight_json: null,
            validation_json: null,
            provider_diff_json: null,
            provider_response_json: {},
            created_at: "2026-04-17T00:00:00.000Z",
            updated_at: "2026-04-17T00:00:00.000Z",
          },
        ];
      }
      return [];
    });
  });

  it("writes canonical business refs for execution state", async () => {
    await upsertCommandCenterExecutionState({
      businessId: "biz-1",
      actionFingerprint: "action-1",
      executionStatus: "pending",
      supportMode: "guided",
      sourceSystem: "meta",
      sourceType: "recommendation",
      requestedAction: "pause",
      workflowStatusSnapshot: "open",
    } as never);

    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain("business_ref_id");
  });

  it("writes canonical business refs for execution audit", async () => {
    sql.mockResolvedValueOnce([]);
    await appendCommandCenterExecutionAudit({
      businessId: "biz-1",
      actionFingerprint: "action-1",
      clientMutationId: "mutation-1",
      operation: "preview",
      executionStatus: "pending",
      supportMode: "guided",
    } as never);

    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain("business_ref_id");
  });
});
