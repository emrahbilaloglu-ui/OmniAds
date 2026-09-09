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
  /*
    ROUND 22, ITEM 1: the bindings view of the same store. `refIds` is what the
    id-only helper returns; `timezones` is what the binding actually holds
    afterwards, which writers now stamp their rows from. Mocked here as the
    identity of what was passed, because these suites are not about the binding
    rule -- lib/provider-account-timezone-authority.db.test.ts proves that
    against a real PostgreSQL.
  */
  ensureProviderAccountReferenceBindings: vi.fn(
    async ({
      accounts,
    }: {
      accounts: Array<{ externalAccountId: string; timezone?: string | null }>;
    }) => ({
      refIds: new Map(
        accounts.map(
          (account) =>
            [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const,
        ),
      ),
      timezones: new Map(
        accounts
          .filter((account) => (account.timezone ?? "").trim().length > 0)
          .map((account) => [account.externalAccountId, String(account.timezone)] as const),
      ),
    }),
  ),
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

vi.mock("@/lib/google-ads/decision-snapshot", () => ({
  normalizeGoogleAdsDecisionSnapshotPayload: vi.fn(
    ({ advisorPayload }: { advisorPayload: Record<string, unknown> }) => advisorPayload,
  ),
}));

const { upsertGoogleAdsAdvisorSnapshot } = await import(
  "@/lib/google-ads/advisor-snapshots"
);

describe("google ads advisor snapshots", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sql.mockResolvedValue([
      {
        id: "snapshot-1",
        business_id: "biz-1",
        account_id: "acct-1",
        analysis_version: "v4",
        as_of_date: "2026-04-16",
        advisor_payload: { metadata: { maturityCutoffDays: 84 } },
        historical_support_json: null,
        source_max_updated_at: null,
        status: "success",
        error_message: null,
        generated_at: "2026-04-16T00:00:00.000Z",
        updated_at: "2026-04-16T00:00:00.000Z",
      },
    ]);
  });

  it("writes canonical refs on snapshot upsert", async () => {
    await upsertGoogleAdsAdvisorSnapshot({
      businessId: "biz-1",
      accountId: "acct-1",
      asOfDate: "2026-04-16",
      advisorPayload: { metadata: { asOfDate: "2026-04-16" } } as never,
      historicalSupport: null,
    });

    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain("business_ref_id");
    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain("provider_account_ref_id");
  });
});
