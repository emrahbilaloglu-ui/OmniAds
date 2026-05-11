import { afterEach, describe, expect, it } from "vitest";
import {
  buildParameterizedQuery,
  buildStatementTimeoutSql,
  getDbRuntimeDiagnostics,
  resetDbClientCache,
  resolveDbPoolMax,
  resolveDbRuntimeSettings,
  resolveDbTimeoutMs,
} from "@/lib/db";

const DB_ENV_KEYS = [
  "SYNC_WORKER_MODE",
  "DB_QUERY_TIMEOUT_MS",
  "DB_WEB_QUERY_TIMEOUT_MS",
  "DB_WORKER_QUERY_TIMEOUT_MS",
  "DB_POOL_MAX",
  "DB_WEB_POOL_MAX",
  "DB_WORKER_POOL_MAX",
  "DB_CONNECTION_TIMEOUT_MS",
  "DB_WEB_CONNECTION_TIMEOUT_MS",
  "DB_WORKER_CONNECTION_TIMEOUT_MS",
  "DB_IDLE_TIMEOUT_MS",
  "DB_WEB_IDLE_TIMEOUT_MS",
  "DB_WORKER_IDLE_TIMEOUT_MS",
  "DB_MAX_LIFETIME_SECONDS",
  "DB_STATEMENT_TIMEOUT_MS",
  "DB_IDLE_IN_TRANSACTION_TIMEOUT_MS",
  "DB_RETRY_ATTEMPTS",
  "DB_WEB_RETRY_ATTEMPTS",
  "DB_WORKER_RETRY_ATTEMPTS",
  "DB_RETRY_BACKOFF_MS",
  "DB_RETRY_MAX_BACKOFF_MS",
  "DB_APPLICATION_NAME",
  "DB_WEB_APPLICATION_NAME",
  "DB_WORKER_APPLICATION_NAME",
] as const;

afterEach(() => {
  resetDbClientCache();
  for (const key of DB_ENV_KEYS) {
    delete process.env[key];
  }
});

describe("resolveDbTimeoutMs", () => {
  it("uses the interactive default when worker mode is disabled", () => {
    expect(resolveDbTimeoutMs({} as NodeJS.ProcessEnv)).toBe(8_000);
  });

  it("uses the worker default when sync worker mode is enabled", () => {
    expect(
      resolveDbTimeoutMs({ SYNC_WORKER_MODE: "1" } as unknown as NodeJS.ProcessEnv),
    ).toBe(30_000);
    expect(
      resolveDbTimeoutMs({ SYNC_WORKER_MODE: "true" } as unknown as NodeJS.ProcessEnv),
    ).toBe(30_000);
  });

  it("prefers role-specific timeout overrides over the shared fallback", () => {
    expect(
      resolveDbTimeoutMs({
        DB_QUERY_TIMEOUT_MS: "12000",
        DB_WEB_QUERY_TIMEOUT_MS: "9000",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(9_000);
    expect(
      resolveDbTimeoutMs({
        SYNC_WORKER_MODE: "1",
        DB_QUERY_TIMEOUT_MS: "12000",
        DB_WORKER_QUERY_TIMEOUT_MS: "45000",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(45_000);
  });
});

describe("resolveDbPoolMax", () => {
  it("uses the interactive default pool size when worker mode is disabled", () => {
    expect(resolveDbPoolMax({} as NodeJS.ProcessEnv)).toBe(10);
  });

  it("uses the worker pool default when sync worker mode is enabled", () => {
    expect(
      resolveDbPoolMax({ SYNC_WORKER_MODE: "1" } as unknown as NodeJS.ProcessEnv),
    ).toBe(12);
  });

  it("prefers role-specific pool overrides over the shared fallback", () => {
    expect(
      resolveDbPoolMax({
        DB_POOL_MAX: "14",
        DB_WEB_POOL_MAX: "11",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(11);
    expect(
      resolveDbPoolMax({
        SYNC_WORKER_MODE: "1",
        DB_POOL_MAX: "14",
        DB_WORKER_POOL_MAX: "24",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(24);
  });
});

describe("resolveDbRuntimeSettings", () => {
  it("resolves distinct web and worker application identities", () => {
    expect(
      resolveDbRuntimeSettings({
        DB_APPLICATION_NAME: "adsecute",
      } as unknown as NodeJS.ProcessEnv),
    ).toMatchObject({
      runtime: "web",
      applicationName: "adsecute-web",
    });
    expect(
      resolveDbRuntimeSettings({
        SYNC_WORKER_MODE: "1",
        DB_APPLICATION_NAME: "adsecute",
      } as unknown as NodeJS.ProcessEnv),
    ).toMatchObject({
      runtime: "worker",
      applicationName: "adsecute-worker",
    });
  });

  it("accepts role-specific tuning for pool, connection, retry, and idle or lifetime controls", () => {
    const settings = resolveDbRuntimeSettings({
      SYNC_WORKER_MODE: "1",
      DB_WORKER_POOL_MAX: "18",
      DB_WORKER_QUERY_TIMEOUT_MS: "45000",
      DB_WORKER_CONNECTION_TIMEOUT_MS: "7000",
      DB_WORKER_IDLE_TIMEOUT_MS: "120000",
      DB_MAX_LIFETIME_SECONDS: "900",
      DB_STATEMENT_TIMEOUT_MS: "60000",
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "15000",
      DB_WORKER_RETRY_ATTEMPTS: "6",
      DB_RETRY_BACKOFF_MS: "250",
      DB_RETRY_MAX_BACKOFF_MS: "5000",
      DB_WORKER_APPLICATION_NAME: "adsecute-bg",
    } as unknown as NodeJS.ProcessEnv);

    expect(settings).toMatchObject({
      runtime: "worker",
      applicationName: "adsecute-bg",
      poolMax: 18,
      queryTimeoutMs: 45_000,
      connectionTimeoutMs: 7_000,
      idleTimeoutMs: 120_000,
      maxLifetimeSeconds: 900,
      statementTimeoutMs: 60_000,
      idleInTransactionSessionTimeoutMs: 15_000,
      retryAttempts: 6,
      retryBackoffMs: 250,
      retryMaxBackoffMs: 5_000,
      allowExitOnIdle: true,
    });
  });
});

describe("getDbRuntimeDiagnostics", () => {
  it("exposes resolved settings and zeroed counters before any pool is created", () => {
    process.env.DB_APPLICATION_NAME = "adsecute";
    process.env.DB_WEB_POOL_MAX = "12";
    process.env.DB_WEB_QUERY_TIMEOUT_MS = "9000";

    const diagnostics = getDbRuntimeDiagnostics();

    expect(diagnostics.runtime).toBe("web");
    expect(diagnostics.applicationName).toBe("adsecute-web");
    expect(diagnostics.settings.poolMax).toBe(12);
    expect(diagnostics.settings.queryTimeoutMs).toBe(9_000);
    expect(diagnostics.pool).toMatchObject({
      max: 12,
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      utilizationPercent: 0,
      saturationState: "idle",
    });
    expect(diagnostics.counters).toMatchObject({
      queryCount: 0,
      successCount: 0,
      failureCount: 0,
      retriedQueryCount: 0,
      retryAttemptCount: 0,
      retryableErrorCount: 0,
      timeoutCount: 0,
      connectionErrorCount: 0,
    });
    expect(diagnostics.lastError).toBeNull();
  });
});

describe("buildParameterizedQuery", () => {
  it("converts a tagged template into a parameterized query", () => {
    expect(
      buildParameterizedQuery(
        ["SELECT * FROM users WHERE id = ", " AND email = ", ""] as unknown as TemplateStringsArray,
        ["user-1", "test@example.com"],
      ),
    ).toEqual({
      text: "SELECT * FROM users WHERE id = $1 AND email = $2",
      values: ["user-1", "test@example.com"],
    });
  });

  it("normalizes undefined values to null", () => {
    expect(
      buildParameterizedQuery(
        ["SELECT * FROM users WHERE avatar IS NOT DISTINCT FROM ", ""] as unknown as TemplateStringsArray,
        [undefined],
      ),
    ).toEqual({
      text: "SELECT * FROM users WHERE avatar IS NOT DISTINCT FROM $1",
      values: [null],
    });
  });
});

describe("buildStatementTimeoutSql", () => {
  it("uses a sanitized millisecond integer for server-side query cancellation", () => {
    expect(buildStatementTimeoutSql(30_000.9)).toBe("SET statement_timeout = 30000");
    expect(buildStatementTimeoutSql(0)).toBe("SET statement_timeout = 1");
    expect(buildStatementTimeoutSql(Number.NaN)).toBe("SET statement_timeout = 1");
  });
});
