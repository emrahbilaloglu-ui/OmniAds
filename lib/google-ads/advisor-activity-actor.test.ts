import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { googlePlanActivityActorLabel } from "@/components/google-ads/google-plan-exact-adapter";

/**
 * The design's Activity `Who` (markup line 1680) names the author of a guarded
 * write. These assertions pin the whole path — the DDL that stores the actor,
 * the writer that fills it from the authorized session, the read that joins it
 * to a member name, and the cell that prints it — so the column cannot quietly
 * fall back to the account id, which names the write's target rather than its
 * author, and so a row with no recorded actor keeps the em dash rather than
 * being attributed to anyone.
 */

const sql = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
  getDbSchemaReadiness: vi.fn().mockResolvedValue({
    ready: true,
    missingTables: [],
    checkedAt: "2026-08-17T00:00:00.000Z",
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
  ensureProviderAccountReferenceIds: vi.fn(
    async ({ accounts }: { accounts: Array<{ externalAccountId: string }> }) =>
      new Map(
        accounts.map(
          (account) =>
            [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const,
        ),
      ),
  ),
  resolveBusinessReferenceIds: vi.fn(
    async (businessIds: string[]) =>
      new Map(businessIds.map((businessId) => [businessId, `business-ref-${businessId}`] as const)),
  ),
}));

const { listAdvisorExecutionEvents, logAdvisorExecutionEvent } = await import(
  "@/lib/google-ads/advisor-memory"
);

function queryText(callIndex = 0) {
  return String(sql.mock.calls[callIndex]?.[0]?.join(" ") ?? "");
}

function queryValues(callIndex = 0) {
  return sql.mock.calls[callIndex]?.slice(1) ?? [];
}

describe("Google advisor activity actor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DATABASE_URL = "postgres://example";
    sql.mockResolvedValue([]);
  });

  it("declares the actor column additively at both DDL create sites", () => {
    const migrations = readFileSync("lib/migrations.ts", "utf8");
    const createSites = migrations.split(
      "CREATE TABLE IF NOT EXISTS google_ads_advisor_execution_logs",
    );
    // Two create sites, both carrying the column for a fresh database.
    expect(createSites.length).toBe(3);
    for (const site of createSites.slice(1)) {
      const body = site.slice(0, site.indexOf("created_at"));
      expect(body).toContain("actor_user_id");
    }
    // And one idempotent ALTER so an existing database gains it without a
    // rewrite. Nullable, with no DEFAULT and no back-fill: an old row must
    // stay unattributed.
    expect(migrations).toContain(
      "ALTER TABLE google_ads_advisor_execution_logs ADD COLUMN IF NOT EXISTS actor_user_id TEXT",
    );
    expect(migrations).not.toContain(
      "UPDATE google_ads_advisor_execution_logs SET actor_user_id",
    );
  });

  it("writes the actor the caller was authorized as", async () => {
    await logAdvisorExecutionEvent({
      businessId: "biz-1",
      accountId: "acct-1",
      recommendationFingerprint: "fp-1",
      mutateActionType: "adjust_portfolio_target",
      operation: "apply",
      status: "applied",
      actorUserId: "usr-1",
    });

    expect(queryText()).toContain("actor_user_id");
    expect(queryValues()).toContain("usr-1");
  });

  it("stores no actor when none was supplied, rather than a placeholder", async () => {
    await logAdvisorExecutionEvent({
      businessId: "biz-1",
      accountId: "acct-1",
      recommendationFingerprint: "fp-1",
      mutateActionType: "adjust_portfolio_target",
      operation: "apply",
      status: "applied",
    });

    const values = queryValues();
    expect(queryText()).toContain("actor_user_id");
    expect(values).toContain(null);
    // The account is never written into the actor slot.
    expect(values.filter((value) => value === "acct-1")).toHaveLength(1);

    sql.mockClear();
    await logAdvisorExecutionEvent({
      businessId: "biz-1",
      accountId: "acct-1",
      recommendationFingerprint: "fp-1",
      mutateActionType: "adjust_portfolio_target",
      operation: "apply",
      status: "applied",
      actorUserId: "   ",
    });
    // A blank string is not an identity.
    expect(queryValues()).toContain(null);
  });

  it("fills the actor from the session at every execution-log write in the route", () => {
    const route = readFileSync("app/api/google-ads/advisor-memory/route.ts", "utf8");
    expect(route).toContain("const actorUserId = access.session?.user?.id ?? null");
    // The body must never be able to name the author.
    expect(route).not.toContain("body.actorUserId");
    expect(route).not.toContain("body?.actorUserId");

    const logCalls = route.split("await logAdvisorExecutionEvent({").slice(1);
    expect(logCalls.length).toBeGreaterThanOrEqual(9);
    for (const call of logCalls) {
      expect(call.slice(0, call.indexOf("});"))).toContain("actorUserId");
    }
  });

  it("joins the stored actor to the member's name on read", async () => {
    sql.mockResolvedValue([]);
    await listAdvisorExecutionEvents({ businessId: "biz-1", accountId: "acct-1" });
    const text = queryText();
    expect(text).toContain("actor_user_id");
    expect(text).toContain("LEFT JOIN users");
    expect(text).toContain("actor_name");
  });

  it("returns a typed actor, and null when the row records none", async () => {
    sql.mockResolvedValue([
      {
        id: "1",
        created_at: "2026-08-15T09:12:00.000Z",
        account_id: "acct-1",
        mutate_action_type: "adjust_portfolio_target",
        operation: "apply",
        status: "applied",
        error_message: null,
        payload_json: null,
        response_json: null,
        actor_user_id: "usr-1",
        actor_name: "Emrah Bilaloglu",
      },
      {
        id: "2",
        created_at: "2026-08-11T10:05:00.000Z",
        account_id: "acct-1",
        mutate_action_type: "remove_negative_keyword",
        operation: "rollback",
        status: "rolled_back",
        error_message: null,
        payload_json: null,
        response_json: null,
        // A row written before the column existed.
        actor_user_id: null,
        actor_name: null,
      },
      {
        id: "3",
        created_at: "2026-08-10T10:05:00.000Z",
        account_id: "acct-1",
        mutate_action_type: "pause_asset",
        operation: "apply",
        status: "applied",
        error_message: null,
        payload_json: null,
        response_json: null,
        // An actor whose user row is gone: authored, but no longer nameable.
        actor_user_id: "usr-gone",
        actor_name: null,
      },
    ]);

    const rows = await listAdvisorExecutionEvents({ businessId: "biz-1" });
    expect(rows[0]?.actor).toEqual({ id: "usr-1", name: "Emrah Bilaloglu" });
    expect(rows[1]?.actor).toBeNull();
    expect(rows[2]?.actor).toEqual({ id: "usr-gone", name: null });

    // And what the design's cell prints for each of the three.
    expect(rows.map((row) => googlePlanActivityActorLabel(row.actor))).toEqual([
      "Emrah Bilaloglu",
      "—",
      "—",
    ]);
  });
});
