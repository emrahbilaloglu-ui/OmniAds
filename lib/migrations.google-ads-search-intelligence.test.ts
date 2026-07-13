import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Google Ads search intelligence migrations", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("ENABLE_RUNTIME_MIGRATIONS", "true");
  });

  it("adds search intelligence foundation tables and columns additively", async () => {
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
      }
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
    expect(joined).toContain("ALTER TABLE google_ads_search_term_daily ADD COLUMN IF NOT EXISTS query_hash TEXT");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS google_ads_query_dictionary");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS google_ads_search_query_hot_daily");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS google_ads_top_query_weekly");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS google_ads_search_cluster_daily");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS google_ads_decision_action_outcome_logs");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS google_ads_retention_runs");
    expect(joined).not.toContain("DROP TABLE google_ads_search_term_daily");
  });
});
