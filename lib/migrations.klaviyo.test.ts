import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/migration-verification", () => ({
  // This suite drives the migration statements against a fake SQL client, so
  // there is no catalog for the post-migration verifier to read. Its own
  // behaviour is covered in lib/migration-verification.test.ts.
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

async function collectMigrationStatements(): Promise<string> {
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
    runDbTransaction: async (operation: () => Promise<unknown>) => operation(),
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

  return queries.join("\n");
}

describe("Klaviyo lifecycle warehouse migration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("ENABLE_RUNTIME_MIGRATIONS", "true");
  });

  it("creates klaviyo_flow_metrics additively and idempotently", async () => {
    const joined = await collectMigrationStatements();

    expect(joined).toContain("CREATE TABLE IF NOT EXISTS klaviyo_flow_metrics");
    expect(joined).toContain(
      "PRIMARY KEY (business_id, provider_account_id, flow_id, window_days)",
    );
    expect(joined).toContain("idx_klaviyo_flow_metrics_business_window");
    expect(joined).toContain(
      "CREATE INDEX IF NOT EXISTS idx_klaviyo_flow_metrics_business_window",
    );
  });

  it("never drops or rewrites the table", async () => {
    const joined = await collectMigrationStatements();

    expect(joined).not.toContain("DROP TABLE IF EXISTS klaviyo_flow_metrics");
    expect(joined).not.toContain("DROP TABLE klaviyo_flow_metrics");
    expect(joined).not.toMatch(/ALTER TABLE klaviyo_flow_metrics\s+DROP COLUMN/);
  });

  it("leaves every metric column nullable with no default, so an absent fact stays absent", async () => {
    const joined = await collectMigrationStatements();
    const table = joined.slice(
      joined.indexOf("CREATE TABLE IF NOT EXISTS klaviyo_flow_metrics"),
    );
    const body = table.slice(0, table.indexOf("PRIMARY KEY"));

    // A `NOT NULL DEFAULT 0` here would render as "$0" / "0%" on a screen whose
    // contract is that an unsupplied fact renders an em-dash.
    for (const column of ["revenue", "open_rate", "recipients"]) {
      const line = body
        .split("\n")
        .find((entry) => entry.trim().startsWith(column));
      expect(line, `${column} column`).toBeTruthy();
      expect(line).not.toContain("NOT NULL");
      expect(line).not.toContain("DEFAULT");
    }
  });
});
