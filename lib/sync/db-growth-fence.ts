import { getDbWithTimeout } from "@/lib/db";

/**
 * Application-observable capacity fence for sync writes.
 *
 * `db-capacity-admission.ts` gates on the *host volume* sampled by an external
 * healthcheck. That signal is necessary but not sufficient: the runaway grew
 * `meta_entity_state_history` to ~76 GiB while the host still had headroom, and
 * by the time the volume alarmed the damage was done. This fence measures what
 * the application can see for itself — total database size and the size of the
 * specific tables known to run away — and refuses new batches before any
 * expensive provider fetch or persist happens.
 *
 * Every uncertainty denies:
 *  - missing table / missing schema,
 *  - malformed or negative measurement,
 *  - any DB error or timeout while measuring.
 *
 * A refusal is never a benign success. Callers receive an explicit decision and
 * are expected to surface it; the diagnostics name the exact table and the exact
 * budget that was crossed so an operator can act without a query.
 */

const DEFAULT_QUERY_TIMEOUT_MS = 5_000;

/** Tables whose unbounded growth caused or amplified the incident. */
/**
 * Every objectively dominant append surface, not just the three tables the
 * first version happened to name.
 *
 * The omissions mattered: `meta_raw_snapshots` alone is ~19.8 GB and
 * `shopify_raw_snapshots` ~13.9 GB, so a fence that measured neither could
 * admit runs while the two largest growth surfaces filled the volume.
 */
export const FENCED_TABLES = [
  "meta_raw_snapshots",
  "shopify_raw_snapshots",
  "meta_entity_state_history",
  "meta_creative_lineage_edges",
  "meta_config_snapshots",
  "meta_campaign_config_history",
  "meta_adset_config_history",
  // Google's dominant append surface. Omitting it would leave the largest
  // Google warehouse table unmeasured while every Meta surface is fenced.
  "google_ads_product_daily",
  "sync_release_gates",
] as const;
export type FencedTable = (typeof FENCED_TABLES)[number];

/**
 * Budgets sized against the real deployment, not a round number.
 *
 * The volume is 207 GB and the live logical database is ~136 GB. The previous
 * default was 120 GiB — BELOW the current healthy size — so deploying it
 * unchanged would have refused every sync immediately. A fence that bricks a
 * healthy database is not a safety feature.
 *
 * 160 GiB is 171.8 GB, leaving ~35 GB of the 207 GB volume for WAL, temp
 * files, index builds and restore margin, while still refusing well before the
 * volume itself becomes unsafe. The warning band opens at 85%, i.e. ~146 GB,
 * which is above today's 136 GB — so the current database is admitted quietly
 * and the first meaningful growth from here starts warning.
 *
 * Units are deliberately explicit: the budget is GiB and the volume is GB.
 * Mixing them is how the previous 120 GiB default ended up below a 136 GB
 * database.
 */
export const PRODUCTION_VOLUME_BYTES = 207 * 1000 ** 3;
export const DEFAULT_DATABASE_BUDGET_BYTES = 160 * 1024 ** 3; // 160 GiB = 171.8 GB
export const DEFAULT_TABLE_BUDGET_BYTES: Record<FencedTable, number> = {
  // Live ~19.8 GB. Generous headroom while the two-layer content model and
  // retention bring it down; still far below a runaway.
  meta_raw_snapshots: 40 * 1024 ** 3,
  // Live ~13.9 GB.
  shopify_raw_snapshots: 30 * 1024 ** 3,
  meta_entity_state_history: 90 * 1024 ** 3,
  meta_creative_lineage_edges: 8 * 1024 ** 3,
  // The config trio. These are amplifiers by nature, so their budgets are
  // deliberately tight: exceeding them means the coalescing guards regressed.
  meta_config_snapshots: 8 * 1024 ** 3,
  meta_campaign_config_history: 4 * 1024 ** 3,
  meta_adset_config_history: 4 * 1024 ** 3,
  google_ads_product_daily: 20 * 1024 ** 3,
  sync_release_gates: 4 * 1024 ** 3,
};

/**
 * Volume reserve, kept DISTINCT from the logical database budget.
 *
 * The database budget answers "is the logical database too large"; this answers
 * "is the volume itself getting close to full", which an aggregate logical
 * budget cannot substitute for — WAL, temp files and index builds consume the
 * volume without appearing in pg_database_size.
 */
export const VOLUME_RESERVE_BYTES = PRODUCTION_VOLUME_BYTES - DEFAULT_DATABASE_BUDGET_BYTES;
/** Warn band: still admitted, but loudly. */
export const DEFAULT_WARNING_RATIO = 0.85;

export type DbGrowthFenceReason =
  | "ready"
  | "database_budget_exceeded"
  | "table_budget_exceeded"
  | "measurement_missing"
  | "measurement_invalid"
  | "fence_read_failed";

export interface DbGrowthFenceDecision {
  allowed: boolean;
  reason: DbGrowthFenceReason;
  warning: boolean;
  databaseBytes: number | null;
  databaseBudgetBytes: number;
  tableBytes: Partial<Record<FencedTable, number>>;
  /** Exact table + budget that denied, for actionable diagnostics. */
  offender: { table: FencedTable | "database"; bytes: number; budget: number } | null;
  evaluatedAt: string;
  errorMessage: string | null;
  /** True when an audited emergency override admitted an otherwise-denied run. */
  overridden: boolean;
}

export const OVERRIDE_ENV_FLAG = "SYNC_GROWTH_FENCE_OVERRIDE";
export const OVERRIDE_ENV_VALUE = "enabled";
export const OVERRIDE_REASON_ENV = "SYNC_GROWTH_FENCE_OVERRIDE_REASON";
/** Overrides expire; a forgotten override must not become permanent. */
export const OVERRIDE_MAX_AGE_MS = 6 * 60 * 60_000;
export const OVERRIDE_EXPIRES_ENV = "SYNC_GROWTH_FENCE_OVERRIDE_EXPIRES_AT";

function denied(input: {
  reason: DbGrowthFenceReason;
  budget: number;
  errorMessage?: string | null;
  evaluatedAt: string;
}): DbGrowthFenceDecision {
  return {
    allowed: false,
    reason: input.reason,
    warning: false,
    databaseBytes: null,
    databaseBudgetBytes: input.budget,
    tableBytes: {},
    offender: null,
    evaluatedAt: input.evaluatedAt,
    errorMessage: input.errorMessage ?? null,
    overridden: false,
  };
}

function readBudget(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number,
) {
  const raw = env[key];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  // A malformed budget is not permission to use the default; deny by making the
  // budget impossible to satisfy is wrong too, so treat it as a hard error.
  if (!Number.isFinite(value) || value <= 0) return Number.NaN;
  return value;
}

/**
 * Audited, bounded, default-off emergency override.
 *
 * Requires the flag, a non-empty human reason, and an explicit future expiry no
 * further out than OVERRIDE_MAX_AGE_MS. Anything else is ignored, so an
 * override cannot be left on by accident.
 */
export function evaluateGrowthFenceOverride(input: {
  env?: Readonly<Record<string, string | undefined>>;
  nowMs?: number;
}): { active: boolean; reason: string | null; issues: string[] } {
  const env = input.env ?? process.env;
  const nowMs = input.nowMs ?? Date.now();
  const issues: string[] = [];
  if ((env[OVERRIDE_ENV_FLAG] ?? "").trim() !== OVERRIDE_ENV_VALUE) {
    issues.push("flag_missing");
  }
  const reason = (env[OVERRIDE_REASON_ENV] ?? "").trim();
  if (reason.length < 12) issues.push("reason_missing");
  const expiresRaw = (env[OVERRIDE_EXPIRES_ENV] ?? "").trim();
  const expiresMs = expiresRaw ? new Date(expiresRaw).getTime() : Number.NaN;
  if (!Number.isFinite(expiresMs)) {
    issues.push("expiry_missing");
  } else if (expiresMs <= nowMs) {
    issues.push("expired");
  } else if (expiresMs - nowMs > OVERRIDE_MAX_AGE_MS) {
    issues.push("expiry_too_far");
  }
  return { active: issues.length === 0, reason: reason || null, issues };
}

export async function evaluateDbGrowthFence(input?: {
  env?: Readonly<Record<string, string | undefined>>;
  nowMs?: number;
  queryTimeoutMs?: number;
}): Promise<DbGrowthFenceDecision> {
  const env = input?.env ?? process.env;
  const evaluatedAt = new Date(input?.nowMs ?? Date.now()).toISOString();
  const databaseBudget = readBudget(
    env,
    "SYNC_GROWTH_FENCE_DATABASE_BYTES",
    DEFAULT_DATABASE_BUDGET_BYTES,
  );
  if (!Number.isFinite(databaseBudget)) {
    return denied({
      reason: "measurement_invalid",
      budget: DEFAULT_DATABASE_BUDGET_BYTES,
      errorMessage: "SYNC_GROWTH_FENCE_DATABASE_BYTES is not a positive number.",
      evaluatedAt,
    });
  }

  let rows: Array<Record<string, unknown>>;
  try {
    const sql = getDbWithTimeout(input?.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
    rows = (await sql.query(
      `
      SELECT
        pg_database_size(current_database())::bigint AS database_bytes,
        t.table_name,
        CASE
          WHEN to_regclass('public.' || t.table_name) IS NULL THEN NULL
          ELSE pg_total_relation_size(to_regclass('public.' || t.table_name))::bigint
        END AS table_bytes
      FROM unnest($1::text[]) AS t(table_name)
    `,
      [[...FENCED_TABLES]],
    )) as Array<Record<string, unknown>>;
  } catch (error) {
    // An unreadable fence is not permission to write.
    return denied({
      reason: "fence_read_failed",
      budget: databaseBudget,
      errorMessage: error instanceof Error ? error.message : String(error),
      evaluatedAt,
    });
  }

  if (rows.length !== FENCED_TABLES.length) {
    return denied({
      reason: "measurement_missing",
      budget: databaseBudget,
      errorMessage: `Expected ${FENCED_TABLES.length} measurements, got ${rows.length}.`,
      evaluatedAt,
    });
  }

  const databaseBytes = Number(rows[0]?.database_bytes);
  if (!Number.isFinite(databaseBytes) || databaseBytes < 0) {
    return denied({
      reason: "measurement_invalid",
      budget: databaseBudget,
      errorMessage: "pg_database_size returned a non-numeric or negative value.",
      evaluatedAt,
    });
  }

  const tableBytes: Partial<Record<FencedTable, number>> = {};
  for (const row of rows) {
    const name = String(row.table_name) as FencedTable;
    if (row.table_bytes == null) {
      // A fenced table that does not exist means the schema is not what this
      // fence was written against; refuse rather than guess.
      return denied({
        reason: "measurement_missing",
        budget: databaseBudget,
        errorMessage: `Fenced table ${name} does not exist.`,
        evaluatedAt,
      });
    }
    const bytes = Number(row.table_bytes);
    if (!Number.isFinite(bytes) || bytes < 0) {
      return denied({
        reason: "measurement_invalid",
        budget: databaseBudget,
        errorMessage: `Invalid size measurement for ${name}.`,
        evaluatedAt,
      });
    }
    tableBytes[name] = bytes;
  }

  // Resolve every table budget ONCE. The warning band must use the same
  // resolved budgets as the denial check, or an operator lowering a budget via
  // env would get a silent admit with no warning right up to the refusal.
  const tableBudgets: Partial<Record<FencedTable, number>> = {};
  for (const table of FENCED_TABLES) {
    const budget = readBudget(
      env,
      `SYNC_GROWTH_FENCE_${table.toUpperCase()}_BYTES`,
      DEFAULT_TABLE_BUDGET_BYTES[table],
    );
    if (!Number.isFinite(budget)) {
      return denied({
        reason: "measurement_invalid",
        budget: databaseBudget,
        errorMessage: `Budget for ${table} is not a positive number.`,
        evaluatedAt,
      });
    }
    tableBudgets[table] = budget;
  }

  let offender: DbGrowthFenceDecision["offender"] = null;
  let reason: DbGrowthFenceReason = "ready";
  if (databaseBytes >= databaseBudget) {
    offender = { table: "database", bytes: databaseBytes, budget: databaseBudget };
    reason = "database_budget_exceeded";
  } else {
    for (const table of FENCED_TABLES) {
      const budget = tableBudgets[table] as number;
      const bytes = tableBytes[table] ?? 0;
      if (bytes >= budget) {
        offender = { table, bytes, budget };
        reason = "table_budget_exceeded";
        break;
      }
    }
  }

  if (offender) {
    const override = evaluateGrowthFenceOverride({ env, nowMs: input?.nowMs });
    if (override.active) {
      console.warn("[db-growth-fence] admitted under emergency override", {
        offender,
        overrideReason: override.reason,
      });
      return {
        allowed: true,
        reason,
        warning: true,
        databaseBytes,
        databaseBudgetBytes: databaseBudget,
        tableBytes,
        offender,
        evaluatedAt,
        errorMessage: null,
        overridden: true,
      };
    }
    console.error("[db-growth-fence] refused new sync work", {
      reason,
      offender,
      overrideIssues: override.issues,
    });
    return {
      allowed: false,
      reason,
      warning: false,
      databaseBytes,
      databaseBudgetBytes: databaseBudget,
      tableBytes,
      offender,
      evaluatedAt,
      errorMessage: null,
      overridden: false,
    };
  }

  const warning =
    databaseBytes >= databaseBudget * DEFAULT_WARNING_RATIO ||
    FENCED_TABLES.some(
      (table) =>
        (tableBytes[table] ?? 0) >=
        (tableBudgets[table] as number) * DEFAULT_WARNING_RATIO,
    );

  return {
    allowed: true,
    reason: "ready",
    warning,
    databaseBytes,
    databaseBudgetBytes: databaseBudget,
    tableBytes,
    offender: null,
    evaluatedAt,
    errorMessage: null,
    overridden: false,
  };
}

export class DbGrowthFenceRefusal extends Error {
  readonly decision: DbGrowthFenceDecision;
  constructor(decision: DbGrowthFenceDecision) {
    super(
      decision.offender
        ? `Sync refused: ${decision.offender.table} is ${decision.offender.bytes} bytes against a ${decision.offender.budget} byte budget (${decision.reason}).`
        : `Sync refused: ${decision.reason}${decision.errorMessage ? ` — ${decision.errorMessage}` : ""}.`,
    );
    this.name = "DbGrowthFenceRefusal";
    this.decision = decision;
  }
}

/**
 * Entry gate for anything that materially grows the database. Throws rather
 * than returning a falsy value so a caller cannot accidentally treat refusal as
 * benign success.
 */
export async function assertDbGrowthFenceAdmits(
  operation: string,
  options?: { env?: Readonly<Record<string, string | undefined>> },
): Promise<DbGrowthFenceDecision> {
  const decision = await evaluateDbGrowthFence({ env: options?.env }).catch(
    (error) =>
      denied({
        reason: "fence_read_failed",
        budget: DEFAULT_DATABASE_BUDGET_BYTES,
        errorMessage: error instanceof Error ? error.message : String(error),
        evaluatedAt: new Date().toISOString(),
      }),
  );
  if (!decision.allowed) {
    console.error("[db-growth-fence] blocked", { operation, decision });
    throw new DbGrowthFenceRefusal(decision);
  }
  return decision;
}


/**
 * Cached admission for hot paths.
 *
 * A queue consumer or partition loop must re-check at work-unit boundaries so a
 * long run cannot cross the budget unchecked, but re-measuring
 * `pg_total_relation_size` on every item would itself be a load problem. An
 * admitted decision is cached briefly; a REFUSAL is never cached, so recovery is
 * immediate once the operator reclaims space.
 */
const ADMITTED_TTL_MS = 15_000;

function fenceCache() {
  const store = globalThis as typeof globalThis & {
    __omniadsGrowthFence?: {
      key: string;
      expiresAt: number;
      decision: DbGrowthFenceDecision;
    };
  };
  return store;
}

/**
 * Cache key covering EVERY input that can change the admission decision.
 *
 * The budgets and the override are read from the environment and the measured
 * sizes come from whichever database DATABASE_URL points at. An unkeyed cache
 * would let a decision taken under one budget/database silently authorise work
 * under another — harmless while budgets are global and the process has one
 * database, but a latent trap the moment either changes. Keying is cheap; the
 * invariant is not worth betting on.
 */
function buildFenceCacheKey(env: Readonly<Record<string, string | undefined>>) {
  const parts = [
    env.DATABASE_URL ?? "",
    env.SYNC_GROWTH_FENCE_DATABASE_BYTES ?? "",
    env[OVERRIDE_ENV_FLAG] ?? "",
    env[OVERRIDE_REASON_ENV] ?? "",
    env[OVERRIDE_EXPIRES_ENV] ?? "",
  ];
  for (const table of FENCED_TABLES) {
    parts.push(env[`SYNC_GROWTH_FENCE_${table.toUpperCase()}_BYTES`] ?? "");
  }
  return parts.join("\u001f");
}

export function resetDbGrowthFenceCache() {
  fenceCache().__omniadsGrowthFence = undefined;
}

/**
 * Boundary guard for every materially DB-growing sync path.
 *
 * Throws on refusal — never returns a falsy "skip" — so no caller can render a
 * capacity refusal as benign success. Callers that have already claimed durable
 * work must let this propagate: the claim remains in its queued/leased state and
 * is retried later, which is recoverable, whereas swallowing it would mark the
 * work done without having done it.
 */
export async function assertSyncGrowthBoundary(
  operation: string,
  options?: {
    env?: Readonly<Record<string, string | undefined>>;
    /** Bypass the cache at a coarse boundary (start of a batch/run). */
    fresh?: boolean;
    now?: () => number;
  },
): Promise<DbGrowthFenceDecision> {
  const now = options?.now ?? (() => Date.now());
  const env = options?.env ?? process.env;
  const cacheKey = buildFenceCacheKey(env);
  const store = fenceCache();
  const cached = store.__omniadsGrowthFence;
  if (
    !options?.fresh &&
    cached &&
    cached.key === cacheKey &&
    cached.expiresAt > now()
  ) {
    return cached.decision;
  }
  const decision = await evaluateDbGrowthFence({ env }).catch(
    (error) =>
      denied({
        reason: "fence_read_failed",
        budget: DEFAULT_DATABASE_BUDGET_BYTES,
        errorMessage: error instanceof Error ? error.message : String(error),
        evaluatedAt: new Date(now()).toISOString(),
      }),
  );
  if (decision.allowed) {
    store.__omniadsGrowthFence = {
      key: cacheKey,
      expiresAt: now() + ADMITTED_TTL_MS,
      decision,
    };
  } else {
    // Never cache a refusal.
    store.__omniadsGrowthFence = undefined;
    console.error("[db-growth-fence] boundary blocked", { operation, decision });
    throw new DbGrowthFenceRefusal(decision);
  }
  return decision;
}
