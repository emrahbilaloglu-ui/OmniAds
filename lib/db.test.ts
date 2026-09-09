import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalStatementTimeoutSql,
  buildParameterizedQuery,
  buildStatementTimeoutSql,
  getDbRuntimeDiagnostics,
  getDbWithTimeout,
  resetDbClientCache,
  resolveDbPoolMax,
  resolveDbRuntimeSettings,
  resolveDbTimeoutMs,
  runDbTransaction,
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
  vi.useRealTimers();
  resetDbClientCache();
  for (const key of DB_ENV_KEYS) {
    delete process.env[key];
  }
});

function fakeClient(
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
) {
  return {
    query: vi.fn(query),
    release: vi.fn(),
  };
}

function installFakePool(clients: ReturnType<typeof fakeClient>[]) {
  const queue = [...clients];
  const pool = {
    connect: vi.fn(async () => {
      const client = queue.shift();
      if (!client) throw new Error("fake pool exhausted");
      return client;
    }),
    end: vi.fn(async () => undefined),
    totalCount: clients.length,
    idleCount: clients.length,
    waitingCount: 0,
  };
  (
    globalThis as typeof globalThis & { __omniadsDbPool?: unknown }
  ).__omniadsDbPool = pool;
  return pool;
}

describe("resolveDbTimeoutMs", () => {
  it("uses the interactive default when worker mode is disabled", () => {
    expect(resolveDbTimeoutMs({} as NodeJS.ProcessEnv)).toBe(8_000);
  });

  it("uses the worker default when sync worker mode is enabled", () => {
    expect(
      resolveDbTimeoutMs({
        SYNC_WORKER_MODE: "1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(30_000);
    expect(
      resolveDbTimeoutMs({
        SYNC_WORKER_MODE: "true",
      } as unknown as NodeJS.ProcessEnv),
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
      resolveDbPoolMax({
        SYNC_WORKER_MODE: "1",
      } as unknown as NodeJS.ProcessEnv),
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
        [
          "SELECT * FROM users WHERE id = ",
          " AND email = ",
          "",
        ] as unknown as TemplateStringsArray,
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
        [
          "SELECT * FROM users WHERE avatar IS NOT DISTINCT FROM ",
          "",
        ] as unknown as TemplateStringsArray,
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
    expect(buildStatementTimeoutSql(30_000.9)).toBe(
      "SET statement_timeout = 30000",
    );
    expect(buildStatementTimeoutSql(0)).toBe("SET statement_timeout = 1");
    expect(buildStatementTimeoutSql(Number.NaN)).toBe(
      "SET statement_timeout = 1",
    );
  });
});

describe("buildLocalStatementTimeoutSql", () => {
  it("uses a transaction-local timeout so pooled connections do not retain job overrides", () => {
    expect(buildLocalStatementTimeoutSql(30_000.9)).toBe(
      "SET LOCAL statement_timeout = 30000",
    );
    expect(buildLocalStatementTimeoutSql(0)).toBe(
      "SET LOCAL statement_timeout = 1",
    );
    expect(buildLocalStatementTimeoutSql(Number.NaN)).toBe(
      "SET LOCAL statement_timeout = 1",
    );
  });
});

describe("pool client cleanup around statement-timeout setup", () => {
  it("destroys a client whose timeout SET misses the caller deadline", async () => {
    vi.useFakeTimers();
    let finishSetup!: (value: { rows: unknown[] }) => void;
    const delayedSetup = new Promise<{ rows: unknown[] }>((resolve) => {
      finishSetup = resolve;
    });
    const client = fakeClient(async (text) => {
      if (text.startsWith("SET statement_timeout")) return delayedSetup;
      return { rows: [] };
    });
    installFakePool([client]);

    const query = getDbWithTimeout(20).query("SELECT 1");
    const rejected = expect(query).rejects.toThrow(
      "Database query timeout setup timed out after 20ms",
    );
    await vi.advanceTimersByTimeAsync(21);
    await rejected;

    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    finishSetup({ rows: [] });
    await vi.runAllTimersAsync();
  });

  it("destroys a setup-failed client and allows the next acquisition to succeed", async () => {
    const setupError = new Error("timeout setup failed");
    const failed = fakeClient(async () => {
      throw setupError;
    });
    const healthy = fakeClient(async () => ({ rows: [{ ok: true }] }));
    const pool = installFakePool([failed, healthy]);
    const sql = getDbWithTimeout(50);

    await expect(sql.query("SELECT 1")).rejects.toBe(setupError);
    expect(failed.release).toHaveBeenCalledWith(setupError);
    await expect(sql.query("SELECT true AS ok")).resolves.toEqual([
      { ok: true },
    ]);
    expect(healthy.release).toHaveBeenCalledWith(undefined);
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });
});

describe("runDbTransaction setup cleanup", () => {
  it("resets a deadline-bound session before returning its client to the pool", async () => {
    const client = fakeClient(async () => ({ rows: [] }));
    installFakePool([client]);

    await expect(
      runDbTransaction(async () => "done", {
        deadlineAtMs: Date.now() + 1_000,
      }),
    ).resolves.toBe("done");

    expect(client.query).toHaveBeenLastCalledWith("RESET statement_timeout");
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("bounds a delayed BEGIN, destroys the uncertain client, and can acquire again", async () => {
    vi.useFakeTimers();
    let finishBegin!: (value: { rows: unknown[] }) => void;
    const delayedBegin = new Promise<{ rows: unknown[] }>((resolve) => {
      finishBegin = resolve;
    });
    const uncertain = fakeClient(async (text) => {
      if (text === "BEGIN") return delayedBegin;
      return { rows: [] };
    });
    const healthy = fakeClient(async () => ({ rows: [] }));
    const pool = installFakePool([uncertain, healthy]);
    const callback = vi.fn(async () => "unreachable");

    const transaction = runDbTransaction(callback, { timeoutMs: 20 });
    const rejected = expect(transaction).rejects.toThrow(
      "Database query timed out after 20ms",
    );
    await vi.advanceTimersByTimeAsync(21);
    await rejected;

    expect(callback).not.toHaveBeenCalled();
    expect(uncertain.query).toHaveBeenCalledWith("ROLLBACK");
    expect(uncertain.release).toHaveBeenCalledWith(expect.any(Error));

    await expect(
      runDbTransaction(async () => "next", { timeoutMs: 20 }),
    ).resolves.toBe("next");
    expect(healthy.release).toHaveBeenCalledWith(undefined);
    expect(pool.connect).toHaveBeenCalledTimes(2);

    finishBegin({ rows: [] });
    await vi.runAllTimersAsync();
  });

  it("rolls back but still destroys a client when SET LOCAL fails", async () => {
    const setupError = new Error("SET LOCAL refused");
    const client = fakeClient(async (text) => {
      if (text.startsWith("SET LOCAL statement_timeout")) throw setupError;
      return { rows: [] };
    });
    installFakePool([client]);
    const callback = vi.fn(async () => undefined);

    await expect(
      runDbTransaction(callback, { timeoutMs: 50 }),
    ).rejects.toBe(setupError);

    expect(callback).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(setupError);
  });
});
