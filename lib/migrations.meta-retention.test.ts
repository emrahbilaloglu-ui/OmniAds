import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/migration-verification", () => ({
  // This suite drives the migration statements against a fake SQL client, so
  // there is no catalog for the post-migration verifier to read. Its own
  // behaviour — including every negative case — is covered in
  // lib/migration-verification.test.ts and end to end by the real-PG seams.
  verifyMigrationSchemaContract: vi.fn(async () => ({ verified: 0 })),
}));

vi.mock("@/lib/meta/automation-claim-schema-verification", () => ({
  // The Automation claim schema's own post-migration gate, neutralized for the
  // same reason and on the same terms as the verifier above: this suite drives
  // the migration statements against a fake SQL client, so there is no catalog
  // to read. It is NOT weakened by being mocked here — it is proven end to end
  // by scripts/ephemeral-postgres-automation-claim-race-seam.ts, which migrates
  // a real PostgreSQL from zero, upgrades a real pre-claim schema, and then
  // reproduces an unrepairable schema state and requires the migration to exit
  // NON-ZERO over it.
  assertMetaAutomationClaimSchema: vi.fn(async () => []),
}));

vi.mock("@/lib/meta/budget-schema-verification", () => ({
  /*
    PRE-DEPLOY AUDIT — the D088 budget schema postcondition, neutralized here
    on exactly the terms of the two gates above: this suite drives the
    migration statements against a fake SQL client, so `information_schema`
    and `pg_constraint` answer nothing and the assertion could only ever
    report the fake catalog's emptiness.

    It is NOT weakened by being mocked here. It is proven end to end against a
    real PostgreSQL by scripts/d088-budget-proposal-migration-seam.ts, which
    migrates from zero, asserts all nine objects by name and definition, and
    then executes both the previous image's three-column upsert and the
    current one to prove the migration stayed survivable by a rollback.
  */
  assertD088BudgetSchema: vi.fn(async () => ({
    contract: "meta.d088-budget-schema-verification.v1",
    verified: [],
  })),
  D088BudgetSchemaError: class extends Error {},
}));

describe("Meta retention migrations", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("ENABLE_RUNTIME_MIGRATIONS", "true");
  });

  it("adds meta retention run tracking additively", async () => {
    const queries: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join(" "));
        return [];
      }),
      {
        query: vi.fn(async (query: string) => {
          queries.push(query);
          return [];
        }),
      },
    );

    vi.doMock("@/lib/db", () => ({
      getDb: () => sql,
      getDbWithTimeout: () => sql,
      runDbTransaction: async (operation: () => Promise<unknown>) =>
        operation(),
    }));
    vi.doMock("@/lib/startup-diagnostics", () => ({
      logStartupError: vi.fn(),
      logStartupEvent: vi.fn(),
    }));

    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({
      force: true,
      reason: "test",
      verifyNativeSchemaCapabilities: false,
    });

    const joined = queries.join("\n");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS meta_retention_runs");
    expect(joined).toContain("CREATE INDEX IF NOT EXISTS idx_meta_retention_runs_finished");
    expect(joined).not.toContain("DROP TABLE meta_authoritative_day_state");
  });
});
