import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Meta decision outcome migrations", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("ENABLE_RUNTIME_MIGRATIONS", "true");
  });

  it("adds Meta decision action outcome logs additively", async () => {
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
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS meta_decision_action_outcome_logs");
    expect(joined).toContain("recommendation_fingerprint TEXT NOT NULL");
    expect(joined).toContain("business_ref_id");
    expect(joined).toContain("provider_account_ref_id");
    expect(joined).toContain("idx_meta_decision_action_outcome_logs_business");
    expect(joined).toContain("idx_meta_decision_action_outcome_logs_recommendation");
    expect(joined).toContain("idx_meta_decision_action_outcome_logs_rec");
    expect(joined).not.toContain("DROP TABLE meta_decision_action_outcome_logs");
  });
});
