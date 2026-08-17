import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/migration-verification", () => ({
  // This suite drives the migration statements against a fake SQL client, so
  // there is no catalog for the post-migration verifier to read. Its own
  // behaviour is covered in lib/migration-verification.test.ts.
  verifyMigrationSchemaContract: vi.fn(async () => ({ verified: 0 })),
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
