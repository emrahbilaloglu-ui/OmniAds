/**
 * THE PINNED MIGRATION LEASE, AS A TEST DOUBLE.
 *
 * ── ROUND 20, ITEM 3 ────────────────────────────────────────────────────────
 * `runMigrations` leases ONE PoolClient for the whole run and proves a
 * `lock_timeout` on it before any DDL. The SQL-capture suites drive the
 * migration against a fake client, so they need a lease-shaped fake: one that
 * records every statement the way their own `sql` mock does, and answers the
 * one query the runner refuses to proceed without -- the session read-back that
 * cross-checks the raw `lock_timeout` in milliseconds and the backend PID.
 *
 * It is deliberately NOT permissive. The read-back it returns is the value the
 * caller says it expects, so a suite cannot accidentally prove the fail-closed
 * check by feeding it agreement it did not ask for; the real negative controls
 * for that check live in the ephemeral-PostgreSQL seams, where a genuine
 * backend answers.
 */

/** The PID the fake lease reports. Arbitrary, but stable and non-zero. */
export const MIGRATION_MOCK_BACKEND_PID = 424_242;

/** Default `MIGRATION_LOCK_TIMEOUT_MS` when the environment sets none. */
export const MIGRATION_DEFAULT_LOCK_TIMEOUT_MS = 15_000;

type CapturingSql = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

/**
 * Wrap a suite's own capturing `sql` mock in the `withPinnedDbClient` callback
 * shape. Statements still land in that mock, so existing emitted-SQL assertions
 * keep working unchanged.
 */
export function pinnedMigrationClientOver(
  sql: CapturingSql,
  options?: { lockTimeoutMs?: number; backendPid?: number },
) {
  const lockTimeoutMs =
    options?.lockTimeoutMs ?? MIGRATION_DEFAULT_LOCK_TIMEOUT_MS;
  const backendPid = options?.backendPid ?? MIGRATION_MOCK_BACKEND_PID;
  return {
    backendPid,
    query: async (text: string, params?: unknown[]) => {
      // Delegated first, so the statement is CAPTURED even when the fake
      // supplies the rows -- a suite asserting on emitted SQL must still see
      // the session read-back it ran.
      const delegated = await sql.query(text, params);
      if (/lock_timeout_ms/.test(text)) {
        return {
          rows: [
            {
              lock_timeout: `${lockTimeoutMs / 1000}s`,
              statement_timeout: "0",
              idle_timeout: "0",
              backend_pid: backendPid,
              lock_timeout_ms: String(lockTimeoutMs),
            },
          ],
        };
      }
      return { rows: Array.isArray(delegated) ? delegated : [] };
    },
  };
}

/**
 * The full `@/lib/db` mock surface the migration runner touches. Kept in one
 * place so a future export cannot go missing from five separate factories --
 * which is exactly how these suites came to fail: Round 18 introduced
 * `withPinnedDbClient` in production and no mock grew it.
 */
export function migrationDbMockModule(
  sql: CapturingSql,
  options?: { lockTimeoutMs?: number; backendPid?: number },
) {
  return {
    getDb: () => sql,
    getDbWithTimeout: () => sql,
    runDbTransaction: async (operation: () => Promise<unknown>) => operation(),
    withPinnedDbClient: async <T>(
      fn: (client: ReturnType<typeof pinnedMigrationClientOver>) => Promise<T>,
    ) => fn(pinnedMigrationClientOver(sql, options)),
    runPinnedDbTransaction: async <T>(input: {
      fn: (db: unknown) => Promise<T>;
    }) => input.fn(sql),
  };
}
