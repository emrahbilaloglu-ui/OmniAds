import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { logStartupEvent } from "@/lib/startup-diagnostics";

const DEFAULT_WEB_DB_TIMEOUT_MS = 8_000;
const DEFAULT_WORKER_DB_TIMEOUT_MS = 30_000;
const DEFAULT_WEB_DB_POOL_MAX = 10;
const DEFAULT_WORKER_DB_POOL_MAX = 12;
const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_DB_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_DB_RETRY_ATTEMPTS = 4;
const DEFAULT_DB_RETRY_BACKOFF_MS = 400;
const DEFAULT_DB_RETRY_MAX_BACKOFF_MS = 4_000;
const DEFAULT_DB_APPLICATION_NAME = "omniads";

type DbRow = Record<string, any>;

export type DbRuntimeRole = "web" | "worker";

export interface DbRuntimeSettings {
  runtime: DbRuntimeRole;
  applicationName: string;
  poolMax: number;
  queryTimeoutMs: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  maxLifetimeSeconds: number | null;
  statementTimeoutMs: number | null;
  idleInTransactionSessionTimeoutMs: number | null;
  retryAttempts: number;
  retryBackoffMs: number;
  retryMaxBackoffMs: number;
  allowExitOnIdle: boolean;
}

export interface DbRuntimePoolSnapshot {
  max: number;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  utilizationPercent: number;
  saturationState: "idle" | "busy" | "saturated";
  maxObservedWaitingCount: number;
  maxObservedUtilizationPercent: number;
  poolWaitEventCount: number;
  lastPoolWaitAt: string | null;
}

export interface DbRuntimeCountersSnapshot {
  queryCount: number;
  successCount: number;
  failureCount: number;
  retriedQueryCount: number;
  retryAttemptCount: number;
  retryableErrorCount: number;
  timeoutCount: number;
  connectionErrorCount: number;
  lastSuccessfulQueryAt: string | null;
  lastRetryableErrorAt: string | null;
  lastTimeoutAt: string | null;
  lastConnectionErrorAt: string | null;
}

export interface DbRuntimeErrorSnapshot {
  at: string;
  code: string | null;
  message: string;
  retryable: boolean;
  timeout: boolean;
  connection: boolean;
}

export interface DbRuntimeDiagnostics {
  sampledAt: string;
  runtime: DbRuntimeRole;
  applicationName: string;
  settings: DbRuntimeSettings;
  pool: DbRuntimePoolSnapshot;
  counters: DbRuntimeCountersSnapshot;
  lastError: DbRuntimeErrorSnapshot | null;
}

interface DbRuntimeMetrics extends DbRuntimeCountersSnapshot {
  lastError: DbRuntimeErrorSnapshot | null;
  maxObservedWaitingCount: number;
  maxObservedUtilizationPercent: number;
  poolWaitEventCount: number;
  lastPoolWaitAt: string | null;
}

export type DbClient = (<TRow extends DbRow = DbRow>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<TRow[]>) & {
  query: <TRow extends DbRow = DbRow>(
    queryText: string,
    params?: unknown[],
  ) => Promise<TRow[]>;
};

type DbQueryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

const dbTransactionStorage = new AsyncLocalStorage<DbClient>();

function nowIso() {
  return new Date().toISOString();
}

function isWorkerRuntime(env: NodeJS.ProcessEnv = process.env) {
  const workerMode = env.SYNC_WORKER_MODE?.trim().toLowerCase();
  return workerMode === "1" || workerMode === "true";
}

export function resolveDbRuntimeRole(
  env: NodeJS.ProcessEnv = process.env,
): DbRuntimeRole {
  return isWorkerRuntime(env) ? "worker" : "web";
}

function resolveRoleScopedRawValue(
  env: NodeJS.ProcessEnv,
  runtime: DbRuntimeRole,
  sharedKey: string,
) {
  const roleSpecificKey =
    runtime === "worker"
      ? sharedKey.replace(/^DB_/, "DB_WORKER_")
      : sharedKey.replace(/^DB_/, "DB_WEB_");
  return env[roleSpecificKey]?.trim() || env[sharedKey]?.trim() || null;
}

function parsePositiveNumber(value: string | null, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveNumber(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveRoleScopedPositiveNumber(input: {
  env?: NodeJS.ProcessEnv;
  runtime?: DbRuntimeRole;
  sharedKey: string;
  fallback: number;
}) {
  const env = input.env ?? process.env;
  const runtime = input.runtime ?? resolveDbRuntimeRole(env);
  return parsePositiveNumber(
    resolveRoleScopedRawValue(env, runtime, input.sharedKey),
    input.fallback,
  );
}

function resolveRoleScopedOptionalPositiveNumber(input: {
  env?: NodeJS.ProcessEnv;
  runtime?: DbRuntimeRole;
  sharedKey: string;
}) {
  const env = input.env ?? process.env;
  const runtime = input.runtime ?? resolveDbRuntimeRole(env);
  return parseOptionalPositiveNumber(
    resolveRoleScopedRawValue(env, runtime, input.sharedKey),
  );
}

function resolveDbApplicationName(
  env: NodeJS.ProcessEnv,
  runtime: DbRuntimeRole,
) {
  const roleSpecific =
    runtime === "worker"
      ? env.DB_WORKER_APPLICATION_NAME?.trim()
      : env.DB_WEB_APPLICATION_NAME?.trim();
  if (roleSpecific) return roleSpecific;
  const raw = env.DB_APPLICATION_NAME?.trim() || DEFAULT_DB_APPLICATION_NAME;
  return raw.includes(runtime) ? raw : `${raw}-${runtime}`;
}

export function resolveDbTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const runtime = resolveDbRuntimeRole(env);
  return resolveRoleScopedPositiveNumber({
    env,
    runtime,
    sharedKey: "DB_QUERY_TIMEOUT_MS",
    fallback:
      runtime === "worker"
        ? DEFAULT_WORKER_DB_TIMEOUT_MS
        : DEFAULT_WEB_DB_TIMEOUT_MS,
  });
}

export function resolveDbPoolMax(env: NodeJS.ProcessEnv = process.env) {
  const runtime = resolveDbRuntimeRole(env);
  return resolveRoleScopedPositiveNumber({
    env,
    runtime,
    sharedKey: "DB_POOL_MAX",
    fallback:
      runtime === "worker"
        ? DEFAULT_WORKER_DB_POOL_MAX
        : DEFAULT_WEB_DB_POOL_MAX,
  });
}

export function resolveDbRuntimeSettings(
  env: NodeJS.ProcessEnv = process.env,
): DbRuntimeSettings {
  const runtime = resolveDbRuntimeRole(env);
  return {
    runtime,
    applicationName: resolveDbApplicationName(env, runtime),
    poolMax: resolveDbPoolMax(env),
    queryTimeoutMs: resolveDbTimeoutMs(env),
    connectionTimeoutMs: resolveRoleScopedPositiveNumber({
      env,
      runtime,
      sharedKey: "DB_CONNECTION_TIMEOUT_MS",
      fallback: DEFAULT_DB_CONNECTION_TIMEOUT_MS,
    }),
    idleTimeoutMs: resolveRoleScopedPositiveNumber({
      env,
      runtime,
      sharedKey: "DB_IDLE_TIMEOUT_MS",
      fallback: DEFAULT_DB_IDLE_TIMEOUT_MS,
    }),
    maxLifetimeSeconds: resolveRoleScopedOptionalPositiveNumber({
      env,
      runtime,
      sharedKey: "DB_MAX_LIFETIME_SECONDS",
    }),
    statementTimeoutMs: resolveRoleScopedOptionalPositiveNumber({
      env,
      runtime,
      sharedKey: "DB_STATEMENT_TIMEOUT_MS",
    }),
    idleInTransactionSessionTimeoutMs: resolveRoleScopedOptionalPositiveNumber({
      env,
      runtime,
      sharedKey: "DB_IDLE_IN_TRANSACTION_TIMEOUT_MS",
    }),
    retryAttempts: resolveRoleScopedPositiveNumber({
      env,
      runtime,
      sharedKey: "DB_RETRY_ATTEMPTS",
      fallback: DEFAULT_DB_RETRY_ATTEMPTS,
    }),
    retryBackoffMs: resolveRoleScopedPositiveNumber({
      env,
      runtime,
      sharedKey: "DB_RETRY_BACKOFF_MS",
      fallback: DEFAULT_DB_RETRY_BACKOFF_MS,
    }),
    retryMaxBackoffMs: resolveRoleScopedPositiveNumber({
      env,
      runtime,
      sharedKey: "DB_RETRY_MAX_BACKOFF_MS",
      fallback: DEFAULT_DB_RETRY_MAX_BACKOFF_MS,
    }),
    allowExitOnIdle: true,
  };
}

function buildDbStartupDetails(settings: DbRuntimeSettings) {
  return {
    runtime: settings.runtime,
    applicationName: settings.applicationName,
    poolMax: settings.poolMax,
    queryTimeoutMs: settings.queryTimeoutMs,
    connectionTimeoutMs: settings.connectionTimeoutMs,
    idleTimeoutMs: settings.idleTimeoutMs,
    maxLifetimeSeconds: settings.maxLifetimeSeconds,
    statementTimeoutMs: settings.statementTimeoutMs,
    idleInTransactionSessionTimeoutMs:
      settings.idleInTransactionSessionTimeoutMs,
    retryAttempts: settings.retryAttempts,
    retryBackoffMs: settings.retryBackoffMs,
    retryMaxBackoffMs: settings.retryMaxBackoffMs,
  };
}

function getDbTimeoutMs() {
  return resolveDbTimeoutMs(process.env);
}

function getDbPoolMax() {
  return resolveDbPoolMax(process.env);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${operation} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      promise
        .finally(() => clearTimeout(timer))
        .catch(() => clearTimeout(timer));
    }),
  ]);
}

function sanitizeStatementTimeoutMs(timeoutMs: number) {
  return Math.max(1, Math.floor(Number.isFinite(timeoutMs) ? timeoutMs : 1));
}

export function buildStatementTimeoutSql(timeoutMs: number) {
  const safeTimeoutMs = sanitizeStatementTimeoutMs(timeoutMs);
  return `SET statement_timeout = ${safeTimeoutMs}`;
}

export function buildLocalStatementTimeoutSql(timeoutMs: number) {
  const safeTimeoutMs = sanitizeStatementTimeoutMs(timeoutMs);
  return `SET LOCAL statement_timeout = ${safeTimeoutMs}`;
}

async function executePoolQueryWithStatementTimeout<TRow extends DbRow = DbRow>(
  pool: Pool,
  queryText: string,
  params: unknown[],
  timeoutMs: number,
) {
  const client = await pool.connect();
  let statementTimeoutApplied = false;
  let releaseError: Error | undefined;
  try {
    await client.query(buildStatementTimeoutSql(timeoutMs));
    statementTimeoutApplied = true;
    return await client.query<TRow>(queryText, params.map(normalizeQueryValue));
  } finally {
    if (statementTimeoutApplied) {
      try {
        await client.query("RESET statement_timeout");
      } catch (error) {
        releaseError =
          error instanceof Error ? error : new Error(String(error));
      }
    }
    client.release(releaseError);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDbErrorCode(error: unknown) {
  if (typeof error !== "object" || !error || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return code == null ? null : String(code);
}

function getDbErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function isTimeoutDbError(error: unknown) {
  const message = getDbErrorMessage(error);
  const code = getDbErrorCode(error);
  return (
    code === "57014" ||
    message.includes("timed out after") ||
    message.includes("statement timeout") ||
    message.includes("Query read timeout") ||
    message.includes("timeout expired")
  );
}

function isConnectionDbError(error: unknown) {
  const message = getDbErrorMessage(error);
  const code = getDbErrorCode(error);
  return (
    code === "08001" ||
    code === "08006" ||
    code === "53300" ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    message.includes("Too many connections attempts") ||
    message.includes("server_login_retry") ||
    message.includes("partial pkt in login phase") ||
    message.includes("server login has been failing") ||
    message.includes("connection closed") ||
    message.includes("server conn crashed") ||
    message.includes("terminating connection") ||
    message.includes("Connection terminated unexpectedly") ||
    message.includes("timeout exceeded when trying to connect") ||
    message.includes("timeout expired")
  );
}

function isRetryableDbError(error: unknown) {
  const code = getDbErrorCode(error);
  return code === "XX000" || isConnectionDbError(error);
}

function classifyDbError(error: unknown) {
  const message = getDbErrorMessage(error);
  const code = getDbErrorCode(error);
  return {
    code,
    message,
    retryable: isRetryableDbError(error),
    timeout: isTimeoutDbError(error),
    connection: isConnectionDbError(error),
  };
}

function computeRetryDelayMs(baseMs: number, maxMs: number, attempt: number) {
  const backoff = Math.max(1, baseMs) * 2 ** attempt;
  return Math.min(Math.max(baseMs, backoff), Math.max(baseMs, maxMs));
}

function getDatabaseUrl() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Make sure your PostgreSQL connection string is configured.",
    );
  }
  return url;
}

function normalizeQueryValue(value: unknown) {
  return value === undefined ? null : value;
}

export function buildParameterizedQuery(
  strings: TemplateStringsArray,
  values: unknown[],
) {
  let text = strings[0] ?? "";
  const params: unknown[] = [];

  for (let index = 0; index < values.length; index += 1) {
    params.push(normalizeQueryValue(values[index]));
    text += `$${index + 1}${strings[index + 1] ?? ""}`;
  }

  return {
    text,
    values: params,
  };
}

function createDbMetrics(): DbRuntimeMetrics {
  return {
    queryCount: 0,
    successCount: 0,
    failureCount: 0,
    retriedQueryCount: 0,
    retryAttemptCount: 0,
    retryableErrorCount: 0,
    timeoutCount: 0,
    connectionErrorCount: 0,
    lastSuccessfulQueryAt: null,
    lastRetryableErrorAt: null,
    lastTimeoutAt: null,
    lastConnectionErrorAt: null,
    lastError: null,
    maxObservedWaitingCount: 0,
    maxObservedUtilizationPercent: 0,
    poolWaitEventCount: 0,
    lastPoolWaitAt: null,
  };
}

function calculatePoolUtilizationPercent(totalCount: number, poolMax: number) {
  if (poolMax <= 0) return 0;
  return Math.round((Math.max(0, totalCount) / poolMax) * 100);
}

function getPoolSaturationState(input: {
  waitingCount: number;
  totalCount: number;
  idleCount: number;
  poolMax: number;
}): DbRuntimePoolSnapshot["saturationState"] {
  if (input.waitingCount > 0) return "saturated";
  if (
    input.totalCount >= Math.max(1, Math.ceil(input.poolMax * 0.75)) ||
    (input.totalCount > 0 && input.idleCount === 0)
  ) {
    return "busy";
  }
  return "idle";
}

function observePoolSnapshot(
  pool: Pool | undefined,
  metrics: DbRuntimeMetrics,
  poolMax: number,
) {
  const totalCount = pool?.totalCount ?? 0;
  const idleCount = pool?.idleCount ?? 0;
  const waitingCount = pool?.waitingCount ?? 0;
  const utilizationPercent = calculatePoolUtilizationPercent(
    totalCount,
    poolMax,
  );
  metrics.maxObservedWaitingCount = Math.max(
    metrics.maxObservedWaitingCount,
    waitingCount,
  );
  metrics.maxObservedUtilizationPercent = Math.max(
    metrics.maxObservedUtilizationPercent,
    utilizationPercent,
  );
  if (waitingCount > 0) {
    metrics.poolWaitEventCount += 1;
    metrics.lastPoolWaitAt = nowIso();
  }
  return {
    max: poolMax,
    totalCount,
    idleCount,
    waitingCount,
    utilizationPercent,
    saturationState: getPoolSaturationState({
      waitingCount,
      totalCount,
      idleCount,
      poolMax,
    }),
    maxObservedWaitingCount: metrics.maxObservedWaitingCount,
    maxObservedUtilizationPercent: metrics.maxObservedUtilizationPercent,
    poolWaitEventCount: metrics.poolWaitEventCount,
    lastPoolWaitAt: metrics.lastPoolWaitAt,
  } satisfies DbRuntimePoolSnapshot;
}

function recordDbError(
  metrics: DbRuntimeMetrics,
  error: ReturnType<typeof classifyDbError>,
) {
  const at = nowIso();
  if (error.retryable) {
    metrics.retryableErrorCount += 1;
    metrics.lastRetryableErrorAt = at;
  }
  if (error.timeout) {
    metrics.timeoutCount += 1;
    metrics.lastTimeoutAt = at;
  }
  if (error.connection) {
    metrics.connectionErrorCount += 1;
    metrics.lastConnectionErrorAt = at;
  }
  metrics.lastError = {
    at,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    timeout: error.timeout,
    connection: error.connection,
  };
}

function getGlobalStore() {
  return globalThis as typeof globalThis & {
    __omniadsDbPool?: Pool;
    __omniadsDbWrapped?: DbClient;
    __omniadsDbWrappedByTimeout?: Map<number, DbClient>;
    __omniadsDbSettings?: DbRuntimeSettings;
    __omniadsDbMetrics?: DbRuntimeMetrics;
  };
}

function getDbMetrics() {
  const globalStore = getGlobalStore();
  if (!globalStore.__omniadsDbMetrics) {
    globalStore.__omniadsDbMetrics = createDbMetrics();
  }
  return globalStore.__omniadsDbMetrics;
}

function getCachedOrResolvedDbSettings(env: NodeJS.ProcessEnv = process.env) {
  return getGlobalStore().__omniadsDbSettings ?? resolveDbRuntimeSettings(env);
}

function createPool(settings: DbRuntimeSettings) {
  const config: PoolConfig = {
    connectionString: getDatabaseUrl(),
    max: settings.poolMax,
    idleTimeoutMillis: settings.idleTimeoutMs,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    allowExitOnIdle: settings.allowExitOnIdle,
    application_name: settings.applicationName,
  };
  if (settings.statementTimeoutMs != null) {
    config.statement_timeout = settings.statementTimeoutMs;
  }
  if (settings.idleInTransactionSessionTimeoutMs != null) {
    config.idle_in_transaction_session_timeout =
      settings.idleInTransactionSessionTimeoutMs;
  }
  if (settings.maxLifetimeSeconds != null) {
    config.maxLifetimeSeconds = settings.maxLifetimeSeconds;
  }

  const pool = new Pool(config);

  pool.on("error", (error) => {
    const metrics = getDbMetrics();
    recordDbError(metrics, classifyDbError(error));
    observePoolSnapshot(pool, metrics, settings.poolMax);
    logStartupEvent("db_pool_error", {
      code: "code" in error ? String(error.code ?? "") : "",
      message: error.message,
      runtime: settings.runtime,
      applicationName: settings.applicationName,
    });
  });

  return pool;
}

function createWrappedDbExecutor(
  queryable: DbQueryable,
  settings: DbRuntimeSettings,
  defaultTimeoutMs: number,
  options?: {
    pool?: Pool;
    allowRetries?: boolean;
  },
): DbClient {
  const pool = options?.pool;
  const allowRetries = options?.allowRetries ?? true;
  const executeQuery = async <TRow extends DbRow = DbRow>(
    queryText: string,
    params: unknown[] = [],
  ) => {
    const metrics = getDbMetrics();
    metrics.queryCount += 1;
    let retried = false;
    const maxAttempts = allowRetries ? settings.retryAttempts : 0;

    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      observePoolSnapshot(pool, metrics, settings.poolMax);
      try {
        const result =
          pool != null && Object.is(queryable, pool)
            ? await executePoolQueryWithStatementTimeout<TRow>(
                pool,
                queryText,
                params,
                defaultTimeoutMs,
              )
            : await withTimeout(
                queryable.query<TRow>(
                  queryText,
                  params.map(normalizeQueryValue),
                ),
                defaultTimeoutMs,
                "Database query",
              );
        metrics.successCount += 1;
        metrics.lastSuccessfulQueryAt = nowIso();
        observePoolSnapshot(pool, metrics, settings.poolMax);
        return result.rows as TRow[];
      } catch (error) {
        const classified = classifyDbError(error);
        recordDbError(metrics, classified);
        observePoolSnapshot(pool, metrics, settings.poolMax);
        const canRetry = classified.retryable && attempt < maxAttempts;
        if (!canRetry) {
          metrics.failureCount += 1;
          throw error;
        }
        if (!retried) {
          metrics.retriedQueryCount += 1;
          retried = true;
        }
        metrics.retryAttemptCount += 1;
        await sleep(
          computeRetryDelayMs(
            settings.retryBackoffMs,
            settings.retryMaxBackoffMs,
            attempt,
          ),
        );
      }
    }

    metrics.failureCount += 1;
    throw new Error("Database query exhausted retry budget.");
  };

  return Object.assign(
    (<TRow extends DbRow = DbRow>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const query = buildParameterizedQuery(strings, values);
      return executeQuery<TRow>(query.text, query.values);
    }) as DbClient,
    {
      query: executeQuery,
    },
  );
}

function createWrappedDb(
  pool: Pool,
  settings: DbRuntimeSettings,
  defaultTimeoutMs: number,
): DbClient {
  return createWrappedDbExecutor(pool, settings, defaultTimeoutMs, {
    pool,
    allowRetries: true,
  });
}

export function getDbResolvedSettings() {
  return { ...getCachedOrResolvedDbSettings() };
}

export function getDbRuntimeDiagnostics(): DbRuntimeDiagnostics {
  const globalStore = getGlobalStore();
  const settings = getCachedOrResolvedDbSettings();
  const metrics = getDbMetrics();
  return {
    sampledAt: nowIso(),
    runtime: settings.runtime,
    applicationName: settings.applicationName,
    settings: { ...settings },
    pool: observePoolSnapshot(
      globalStore.__omniadsDbPool,
      metrics,
      settings.poolMax,
    ),
    counters: {
      queryCount: metrics.queryCount,
      successCount: metrics.successCount,
      failureCount: metrics.failureCount,
      retriedQueryCount: metrics.retriedQueryCount,
      retryAttemptCount: metrics.retryAttemptCount,
      retryableErrorCount: metrics.retryableErrorCount,
      timeoutCount: metrics.timeoutCount,
      connectionErrorCount: metrics.connectionErrorCount,
      lastSuccessfulQueryAt: metrics.lastSuccessfulQueryAt,
      lastRetryableErrorAt: metrics.lastRetryableErrorAt,
      lastTimeoutAt: metrics.lastTimeoutAt,
      lastConnectionErrorAt: metrics.lastConnectionErrorAt,
    },
    lastError: metrics.lastError ? { ...metrics.lastError } : null,
  };
}

/**
 * Returns a PostgreSQL SQL-tagged-template query function.
 * Uses DATABASE_URL by default.
 *
 * Usage:
 *   const sql = getDb();
 *   const rows = await sql`SELECT 1 AS ok`;
 */
export function getDb() {
  const transactionClient = dbTransactionStorage.getStore();
  if (transactionClient) {
    return transactionClient;
  }
  const globalStore = getGlobalStore();
  if (globalStore.__omniadsDbWrapped) {
    return globalStore.__omniadsDbWrapped;
  }

  const settings = resolveDbRuntimeSettings(process.env);
  const pool = globalStore.__omniadsDbPool ?? createPool(settings);
  const wrapped = createWrappedDb(pool, settings, getDbTimeoutMs());

  globalStore.__omniadsDbPool = pool;
  globalStore.__omniadsDbSettings = settings;
  globalStore.__omniadsDbWrapped = wrapped;
  logStartupEvent("db_client_initialized", buildDbStartupDetails(settings));
  return wrapped;
}

export function getDbWithTimeout(timeoutMs: number) {
  const transactionClient = dbTransactionStorage.getStore();
  if (transactionClient) {
    return transactionClient;
  }
  const globalStore = getGlobalStore();
  if (!globalStore.__omniadsDbPool) {
    const settings = resolveDbRuntimeSettings(process.env);
    globalStore.__omniadsDbSettings = settings;
    globalStore.__omniadsDbPool = createPool(settings);
    logStartupEvent("db_client_initialized", buildDbStartupDetails(settings));
  }
  if (!globalStore.__omniadsDbWrappedByTimeout) {
    globalStore.__omniadsDbWrappedByTimeout = new Map();
  }
  const existing = globalStore.__omniadsDbWrappedByTimeout.get(timeoutMs);
  if (existing) return existing;

  const settings = getCachedOrResolvedDbSettings();
  const wrapped = createWrappedDb(
    globalStore.__omniadsDbPool,
    settings,
    timeoutMs,
  );
  globalStore.__omniadsDbWrappedByTimeout.set(timeoutMs, wrapped);
  logStartupEvent("db_client_timeout_wrapper_initialized", {
    runtime: settings.runtime,
    applicationName: settings.applicationName,
    timeoutMs,
    poolMax: settings.poolMax,
  });
  return wrapped;
}

export async function runDbTransaction<T>(
  fn: () => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  const existingTransactionClient = dbTransactionStorage.getStore();
  if (existingTransactionClient) {
    return fn();
  }

  const globalStore = getGlobalStore();
  if (!globalStore.__omniadsDbPool) {
    const settings = resolveDbRuntimeSettings(process.env);
    globalStore.__omniadsDbSettings = settings;
    globalStore.__omniadsDbPool = createPool(settings);
    logStartupEvent("db_client_initialized", buildDbStartupDetails(settings));
  }

  const pool = globalStore.__omniadsDbPool;
  const settings = getCachedOrResolvedDbSettings();
  const client = await pool.connect();
  const timeoutMs = options?.timeoutMs ?? getDbTimeoutMs();
  const wrapped = createWrappedDbExecutor(client, settings, timeoutMs, {
    pool,
    allowRetries: false,
  });

  await wrapped.query("BEGIN");
  await wrapped.query(buildLocalStatementTimeoutSql(timeoutMs));
  try {
    const result = await dbTransactionStorage.run(wrapped, fn);
    await wrapped.query("COMMIT");
    return result;
  } catch (error) {
    await wrapped.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function resetDbClientCache() {
  const globalStore = getGlobalStore();

  void globalStore.__omniadsDbPool?.end().catch(() => undefined);
  delete globalStore.__omniadsDbPool;
  delete globalStore.__omniadsDbWrapped;
  globalStore.__omniadsDbWrappedByTimeout?.clear();
  delete globalStore.__omniadsDbWrappedByTimeout;
  delete globalStore.__omniadsDbSettings;
  delete globalStore.__omniadsDbMetrics;
}
