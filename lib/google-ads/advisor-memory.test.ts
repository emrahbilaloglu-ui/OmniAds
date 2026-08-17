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
  ensureProviderAccountReferenceIds: vi.fn(async ({ accounts }: { accounts: Array<{ externalAccountId: string }> }) => {
    return new Map(
      accounts.map((account) => [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const),
    );
  }),
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `business-ref-${businessId}`] as const),
    );
  }),
}));

const {
  listAdvisorExecutionEvents,
  logAdvisorExecutionEvent,
  updateAdvisorExecutionState,
  updateAdvisorMemoryAction,
} = await import("@/lib/google-ads/advisor-memory");

describe("google ads advisor memory writes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DATABASE_URL = "postgres://example";
    sql.mockResolvedValue([]);
  });

  it("writes canonical refs for advisor execution logs", async () => {
    await logAdvisorExecutionEvent({
      businessId: "biz-1",
      accountId: "acct-1",
      recommendationFingerprint: "fingerprint-1",
      mutateActionType: "apply_budget",
      operation: "mutate",
      status: "success",
    });

    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain("business_ref_id");
    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain("provider_account_ref_id");
  });

  it("fills canonical refs when updating advisor memory rows", async () => {
    await updateAdvisorExecutionState({
      businessId: "biz-1",
      accountId: "acct-1",
      recommendationFingerprint: "fingerprint-1",
      executionStatus: "applied",
      executionMetadata: { mutateActionType: "apply_budget" },
    });

    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain("business_ref_id = COALESCE");
    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain("provider_account_ref_id = COALESCE");
  });

  it("returns the exact affected dismissal row as the memory receipt", async () => {
    sql
      .mockResolvedValueOnce([{ recommendation_type: "budget_reallocation" }])
      .mockResolvedValueOnce([
        {
          recommendation_fingerprint: "fingerprint-1",
          current_status: "suppressed",
          user_action: "dismissed",
          suppress_until: "2026-08-24T00:00:00.000Z",
        },
      ]);

    await expect(
      updateAdvisorMemoryAction({
        businessId: "biz-1",
        accountId: "acct-1",
        recommendationFingerprint: "fingerprint-1",
        action: "dismissed",
      }),
    ).resolves.toEqual({
      matched: true,
      recommendationFingerprint: "fingerprint-1",
      currentStatus: "suppressed",
      userAction: "dismissed",
      suppressUntil: "2026-08-24T00:00:00.000Z",
    });
  });

  it("does not perform an update when the fingerprint has no account-scoped row", async () => {
    sql.mockResolvedValueOnce([]);

    await expect(
      updateAdvisorMemoryAction({
        businessId: "biz-1",
        accountId: "acct-1",
        recommendationFingerprint: "stale-fingerprint",
        action: "dismissed",
      }),
    ).resolves.toMatchObject({ matched: false });

    expect(sql).toHaveBeenCalledTimes(1);
  });
});

/**
 * The Plan screen's Activity feed reads this. The receipt it prints is the
 * `transactionId` the execution boundary stamps into the logged response (and,
 * on the pending row, the payload) — never a rendered id.
 */
describe("google ads advisor execution log reads", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DATABASE_URL = "postgres://example";
  });

  it("selects the payload and response so the receipt can be read", async () => {
    sql.mockResolvedValue([]);
    await listAdvisorExecutionEvents({ businessId: "biz-1", accountId: "acct-1" });
    const text = String(sql.mock.calls[0]?.[0]?.join(" ") ?? "");
    expect(text).toContain("payload_json");
    expect(text).toContain("response_json");
    expect(text).toContain("google_ads_advisor_execution_logs");
  });

  it("reads the receipt from the response, then the payload, else null", async () => {
    sql.mockResolvedValue([
      {
        id: "1",
        created_at: "2026-08-15T09:12:00.000Z",
        account_id: "acct-1",
        mutate_action_type: "adjust_portfolio_target",
        operation: "apply",
        status: "applied",
        error_message: null,
        payload_json: { transactionId: "payload-receipt" },
        response_json: { transactionId: "response-receipt" },
      },
      {
        id: "2",
        created_at: "2026-08-15T09:11:00.000Z",
        account_id: "acct-1",
        mutate_action_type: "adjust_portfolio_target",
        operation: "apply",
        status: "pending",
        error_message: null,
        payload_json: { transactionId: "payload-receipt" },
        response_json: null,
      },
      {
        id: "3",
        created_at: "2026-08-15T09:10:00.000Z",
        account_id: "acct-1",
        mutate_action_type: "adjust_portfolio_target",
        operation: "apply",
        status: "failed",
        error_message: "Quiet hours",
        payload_json: null,
        response_json: null,
      },
    ]);

    const rows = await listAdvisorExecutionEvents({ businessId: "biz-1" });

    expect(rows.map((row) => row.receiptId)).toEqual([
      "response-receipt",
      "payload-receipt",
      null,
    ]);
    expect(rows[2]?.detail).toBe("Quiet hours");
  });
});
