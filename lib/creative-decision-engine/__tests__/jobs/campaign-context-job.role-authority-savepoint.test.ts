import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A failed role-authority row must not cost the business-day's context rows.
 *
 * The job's own comment says so ("A failure here does not fail the job"), and
 * the code used to honour it only in JavaScript: the error was swallowed with
 * `.catch(() => null)` inside the job's single transaction. PostgreSQL had
 * already put that transaction into the aborted state, so the next context
 * upsert and the success UPDATE failed, and the job's catch rolled back to its
 * own savepoint — every context row for the day gone.
 *
 * The recording database below models exactly that PostgreSQL rule: after a
 * failed statement every further statement throws until a ROLLBACK TO
 * SAVEPOINT restores the transaction. A negative control proves the model.
 */

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ACCOUNT_ID = "act_1234567890";
const CAMPAIGNS = ["23851234567890111", "23851234567890222"];

const recorded: string[] = [];
let aborted = false;
let failAuthorityInsert = true;

function fakeQuery(sql: string): unknown[] {
  if (aborted && !sql.startsWith("ROLLBACK TO SAVEPOINT")) {
    throw new Error("current transaction is aborted, commands ignored until end of transaction block");
  }
  recorded.push(sql);
  if (sql.startsWith("ROLLBACK TO SAVEPOINT")) {
    aborted = false;
    return [];
  }
  if (sql.includes("pg_try_advisory_xact_lock")) return [{ acquired: true }];
  if (sql.includes("INSERT INTO engine_v3_job_runs")) {
    return [{ id: "22222222-2222-4222-8222-222222222222" }];
  }
  if (sql.includes("INSERT INTO engine_v3_campaign_role_authority") && failAuthorityInsert) {
    aborted = true;
    throw new Error("simulated lock timeout on the authority table");
  }
  return [];
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: async (sql: string) => fakeQuery(sql) }),
  runDbTransaction: async <T,>(fn: () => Promise<T>) => fn(),
}));

vi.mock("../../jobs/business-guard", () => ({
  getBusinessGuardFailure: async () => null,
}));

vi.mock("../../feature-flags", () => ({
  resolveEngineV3Flags: async () => ({ enabled: true }),
}));

vi.mock("../../campaign-context/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../campaign-context/data")>();
  return {
    ...actual,
    readCampaignContextCreativeDays: async () =>
      CAMPAIGNS.map((campaignId) => ({ providerAccountId: PROVIDER_ACCOUNT_ID, campaignId })),
    readCampaignContextCampaignMeta: async () => [],
    computeCampaignLineage: () => ({}),
    buildCampaignContextFeatures: () =>
      CAMPAIGNS.map((campaignId) => ({ campaignId, campaignName: null })),
  };
});

vi.mock("../../campaign-context/resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../campaign-context/resolver")>();
  return {
    ...actual,
    classifyCampaignContext: (feature: { campaignId: string }) => ({
      campaignId: feature.campaignId,
      campaignName: null,
      kind: "main",
      kindSource: "system_inferred",
      confidenceClass: "high",
      confidenceScore: 0.9,
      testScore: 0.1,
      mainScore: 0.9,
      mixedScore: 0,
      agreeingFamilies: [],
      conflictReasons: [],
      evidence: ["scripted"],
      resolverVersion: actual.CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    }),
  };
});

const { runCampaignContextJob, UPSERT_ROLE_AUTHORITY_QUERY } = await import(
  "../../jobs/campaign-context-job"
);

describe("a failed role-authority row is confined to its savepoint", () => {
  beforeEach(() => {
    recorded.length = 0;
    aborted = false;
    failAuthorityInsert = true;
  });

  it("the recording database models PostgreSQL's aborted-transaction rule", () => {
    // NEGATIVE CONTROL: without a savepoint rollback, the statement after a
    // failure throws — the exact state the old .catch(() => null) left behind.
    expect(UPSERT_ROLE_AUTHORITY_QUERY).toContain("INSERT INTO engine_v3_campaign_role_authority");
    expect(() => fakeQuery(UPSERT_ROLE_AUTHORITY_QUERY)).toThrow(/lock timeout/);
    expect(() => fakeQuery("SELECT 1")).toThrow(/transaction is aborted/);
    expect(() => fakeQuery("ROLLBACK TO SAVEPOINT anything")).not.toThrow();
    expect(() => fakeQuery("SELECT 1")).not.toThrow();
  });

  it("POSITIVE: every campaign's context row commits and the run succeeds", async () => {
    const result = await runCampaignContextJob({ businessId: BUSINESS_ID, asOf: "2026-09-12" });
    expect(result.status).toBe("success");
    const contextUpserts = recorded.filter((sql) =>
      sql.includes("INSERT INTO engine_v3_campaign_context_daily"),
    );
    expect(contextUpserts).toHaveLength(CAMPAIGNS.length);
    // Each failed row was rolled back to its own savepoint, not the job's.
    expect(recorded.filter((sql) => sql === "ROLLBACK TO SAVEPOINT engine_v3_role_authority_row"))
      .toHaveLength(CAMPAIGNS.length);
    expect(recorded).not.toContain("ROLLBACK TO SAVEPOINT engine_v3_campaign_context_job_work");
    expect(recorded.some((sql) => sql.includes("SET status = 'success'"))).toBe(true);
  });

  it("releases the row savepoint on the success path too", async () => {
    failAuthorityInsert = false;
    const result = await runCampaignContextJob({ businessId: BUSINESS_ID, asOf: "2026-09-12" });
    expect(result.status).toBe("success");
    expect(recorded.filter((sql) => sql === "SAVEPOINT engine_v3_role_authority_row"))
      .toHaveLength(CAMPAIGNS.length);
    expect(recorded.filter((sql) => sql === "RELEASE SAVEPOINT engine_v3_role_authority_row"))
      .toHaveLength(CAMPAIGNS.length);
    expect(recorded).not.toContain("ROLLBACK TO SAVEPOINT engine_v3_role_authority_row");
  });
});
