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
  // The observation receipts. Content sharing moved the row volume, not the
  // row COUNT: every observation that used to append a full payload row now
  // appends a receipt. They are small per row but they are append-only and
  // grow at exactly the old rate, so leaving them unfenced would recreate the
  // original blind spot one layer down.
  "meta_raw_snapshot_observations",
  "shopify_raw_snapshot_observations",
  // Google's remaining unbounded append surfaces. Only google_ads_product_daily
  // was fenced, which left the raw payload table and every Google lifecycle
  // surface free to grow unmeasured — the exact asymmetry that let the Meta
  // side be caught while the Google side was not.
  "google_ads_raw_snapshots",
  "google_ads_campaign_state_history",
  "google_ads_ad_group_state_history",
  "google_ads_sync_runs",
  "google_ads_sync_jobs",
  // Meta lifecycle surfaces, append-only per work unit for the same reason.
  "meta_sync_runs",
  "meta_sync_jobs",
  // Shopify's payload archive and its event stream.
  "shopify_entity_payload_archives",
  "shopify_sales_events",
] as const;
export type FencedTable = (typeof FENCED_TABLES)[number];

/**
 * Read-only measurements taken from the live production database.
 *
 * Kept as named constants rather than folded into the budgets, because the
 * budgets are only defensible with the numbers they were derived from sitting
 * next to them. Every previous budget in this file was a round number chosen
 * without a measurement, and two of them were BELOW the live size.
 */
export const LIVE_MEASUREMENT = {
  databaseBytes: 146_500_598_807,
  tableBytes: {
    meta_config_snapshots: 22_845_751_296,
    meta_campaign_config_history: 22_458_515_456,
    meta_adset_config_history: 21_907_480_576,
    meta_raw_snapshots: 19_839_328_256,
    shopify_raw_snapshots: 13_889_986_560,
    google_ads_product_daily: 10_712_031_232,
    meta_creative_lineage_edges: 3_267_026_944,
    meta_entity_state_history: 2_998_468_608,
    sync_release_gates: 1_348_296_704,
    google_ads_raw_snapshots: 996_720_640,
  },
  /**
   * Filesystem statistics for the PostgreSQL data directory, taken at the same
   * time. These are a POINT-IN-TIME OBSERVATION, not telemetry this process can
   * read — the database host's filesystem is not visible from the app.
   */
  volume: {
    mountPoint: "/var/lib/postgresql",
    capacityBytes: 221_348_159_488,
    usedBytes: 107_552_600_064,
    availableBytes: 112_683_569_152,
  },
} as const;

/**
 * Aggregate budget: 160 GiB. Derived, not chosen.
 *
 * The constraint set is:
 *   - live logical database          136.44 GiB
 *   - volume capacity                206.15 GiB
 *   - volume free                    104.94 GiB
 *   - host free-space floor           40.00 GiB
 *   - warning band                    85% of the budget
 *
 * The binding requirement is that the fence must still WARN today. The warning
 * band is what gives any notice at all before refusal, and a budget whose band
 * sits above the live size starts silent. 160 GiB puts the band at 136.00 GiB,
 * just below the live 136.44 GiB — so it warns now. 165 GiB and above do not
 * (bands at 140.3 GiB and up), which is why they are rejected despite the extra
 * headroom.
 *
 * Among the budgets that still warn, take the largest. 150 GiB warns too, but
 * leaves only 13.56 GiB of headroom, and there is currently NO way to reclaim
 * space: the ~63 GiB Meta config trio has verified backups but cannot be
 * logically deleted or compacted safely, and the cleanup planner deliberately
 * ships no executor. A budget that assumes that space will come back is
 * depending on work that does not exist. 160 GiB gives 23.56 GiB of headroom
 * against real growth without that assumption.
 *
 * Disk safety holds at 160 GiB: consuming the entire remaining budget adds
 * 23.56 GiB, which against 104.94 GiB free leaves ~81 GiB — far above the
 * 40 GiB floor. That calculation deliberately assumes one logical byte costs
 * one filesystem byte, which is conservative: measured filesystem usage
 * (100.17 GiB) is currently BELOW the logical database size, and the reason for
 * that gap is not established here, so the pessimistic direction is the one to
 * assume.
 *
 * The per-table ceilings sum to 180 GiB, above this aggregate on purpose. The
 * aggregate binds first and catches total growth; the per-table ceilings exist
 * to catch a single relation running away inside it.
 *
 * Units are explicit throughout. The previous 120 GiB default was below a
 * 136 GB database precisely because GiB and GB were mixed.
 */
export const DEFAULT_DATABASE_BUDGET_BYTES = 160 * 1024 ** 3; // 160 GiB = 171.80 GB
export const DEFAULT_TABLE_BUDGET_BYTES: Record<FencedTable, number> = {
  // The config trio: 60 GiB between them, and every byte of it is the
  // amplification. Budgets are just above live so any regrowth refuses almost
  // immediately, and they must come DOWN as retention compacts them.
  meta_config_snapshots: 24 * 1024 ** 3, // live 21.3 GiB
  meta_campaign_config_history: 24 * 1024 ** 3, // live 20.9 GiB
  meta_adset_config_history: 23 * 1024 ** 3, // live 20.4 GiB
  meta_raw_snapshots: 22 * 1024 ** 3, // live 18.5 GiB
  shopify_raw_snapshots: 16 * 1024 ** 3, // live 12.9 GiB
  google_ads_product_daily: 12 * 1024 ** 3, // live 9.98 GiB
  meta_creative_lineage_edges: 5 * 1024 ** 3, // live 3.04 GiB
  // Post-compaction ceiling. The old 90 GiB budget would have let this regrow
  // to tens of gigabytes without a single refusal, which is exactly how it got
  // large the first time. 4 GiB against a live 2.79 GiB means any renewed
  // per-historical-day observation writing refuses within days.
  meta_entity_state_history: 4 * 1024 ** 3, // live 2.79 GiB
  sync_release_gates: 3 * 1024 ** 3, // live 1.26 GiB
  google_ads_raw_snapshots: 3 * 1024 ** 3, // live 0.93 GiB
  // New relations: zero today. Budgets sized for the observation rate the
  // payload tables used to carry, which is what they now absorb.
  meta_raw_snapshot_observations: 6 * 1024 ** 3,
  shopify_raw_snapshot_observations: 4 * 1024 ** 3,
  // Not separately measured on the live database, so these are conservative
  // ceilings rather than derived budgets. Stated as such: they exist to catch a
  // runaway, not to certify a known size.
  google_ads_campaign_state_history: 4 * 1024 ** 3,
  google_ads_ad_group_state_history: 4 * 1024 ** 3,
  google_ads_sync_runs: 3 * 1024 ** 3,
  google_ads_sync_jobs: 3 * 1024 ** 3,
  meta_sync_runs: 3 * 1024 ** 3,
  meta_sync_jobs: 3 * 1024 ** 3,
  shopify_entity_payload_archives: 8 * 1024 ** 3,
  shopify_sales_events: 6 * 1024 ** 3,
};

/**
 * Arithmetic planning constant. NOT disk telemetry.
 *
 * This is `observed capacity − logical budget` and nothing more. It does not
 * measure free space, it cannot see WAL, temp files or index builds, and it is
 * stale the moment the observation above is. Admission on actual filesystem
 * headroom is a SEPARATE decision — see `evaluateVolumeHeadroom` — and requires
 * a measurement supplied from the database host, because this process cannot
 * read that filesystem at all.
 */
export const PLANNED_VOLUME_HEADROOM_BYTES =
  LIVE_MEASUREMENT.volume.capacityBytes - DEFAULT_DATABASE_BUDGET_BYTES;

/**
 * Minimum free space on the PostgreSQL data volume before growth is unsafe.
 *
 * Sized for a concurrent index build plus WAL burst on the largest relations
 * this fence covers.
 */
export const MINIMUM_VOLUME_FREE_BYTES = 40 * 1024 ** 3;

export const VOLUME_AVAILABLE_ENV = "SYNC_GROWTH_FENCE_VOLUME_AVAILABLE_BYTES";
export const VOLUME_CAPACITY_ENV = "SYNC_GROWTH_FENCE_VOLUME_CAPACITY_BYTES";

export type VolumeHeadroomStatus = "unknown" | "ok" | "low";

export interface VolumeHeadroomDecision {
  status: VolumeHeadroomStatus;
  availableBytes: number | null;
  capacityBytes: number | null;
  minimumFreeBytes: number;
  /** Plain-language statement of what this does and does not establish. */
  note: string;
}

/**
 * External filesystem admission, kept deliberately separate from the logical
 * budget.
 *
 * Returns `unknown` — never `ok` — when no measurement was supplied. An absent
 * measurement is an absence of evidence; reporting it as healthy is how a
 * logical budget ends up being mistaken for disk headroom.
 */
export function evaluateVolumeHeadroom(input?: {
  env?: Readonly<Record<string, string | undefined>>;
}): VolumeHeadroomDecision {
  const env = input?.env ?? process.env;
  const parse = (raw: string | undefined) => {
    if (raw == null || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const availableBytes = parse(env[VOLUME_AVAILABLE_ENV]);
  const capacityBytes = parse(env[VOLUME_CAPACITY_ENV]);
  if (availableBytes == null) {
    return {
      status: "unknown",
      availableBytes: null,
      capacityBytes,
      minimumFreeBytes: MINIMUM_VOLUME_FREE_BYTES,
      note: `No filesystem measurement supplied via ${VOLUME_AVAILABLE_ENV}. The logical database budget says nothing about free disk; treat volume headroom as unverified.`,
    };
  }
  return {
    status: availableBytes >= MINIMUM_VOLUME_FREE_BYTES ? "ok" : "low",
    availableBytes,
    capacityBytes,
    minimumFreeBytes: MINIMUM_VOLUME_FREE_BYTES,
    note: "Measured on the database host and supplied to this process; it is as fresh as whatever produced it.",
  };
}

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

/**
 * Recognise a capacity refusal that has been caught and turned into a value.
 *
 * Routes aggregate lane results with Promise.allSettled and render rejections
 * as `{ error }` while still answering `ok: true`. A capacity refusal reported
 * that way is indistinguishable from success to anything reading the response,
 * which is precisely the failure mode that let an incident run unnoticed. This
 * lets a route pick refusals back out of an aggregated result and answer
 * truthfully.
 *
 * Matches on the class first and the discriminant second, so a refusal that
 * crossed a serialization boundary is still recognised.
 */
export function describeGrowthFenceRefusal(
  error: unknown,
): { operation: string | null; decision: DbGrowthFenceDecision } | null {
  if (error instanceof DbGrowthFenceRefusal) {
    return { operation: error.operation, decision: error.decision };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "DbGrowthFenceRefusal" &&
    typeof (error as { decision?: unknown }).decision === "object"
  ) {
    return {
      operation: (error as { operation?: string | null }).operation ?? null,
      decision: (error as { decision: DbGrowthFenceDecision }).decision,
    };
  }
  return null;
}

export class DbGrowthFenceRefusal extends Error {
  readonly decision: DbGrowthFenceDecision;
  /** Which boundary refused, so an aggregated response can name the lane. */
  readonly operation: string | null;
  constructor(decision: DbGrowthFenceDecision, operation?: string | null) {
    super(
      decision.offender
        ? `Sync refused: ${decision.offender.table} is ${decision.offender.bytes} bytes against a ${decision.offender.budget} byte budget (${decision.reason}).`
        : `Sync refused: ${decision.reason}${decision.errorMessage ? ` — ${decision.errorMessage}` : ""}.`,
    );
    this.name = "DbGrowthFenceRefusal";
    this.decision = decision;
    this.operation = operation ?? null;
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
    throw new DbGrowthFenceRefusal(decision, operation);
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
    if (decision.warning) {
      // An admitted-with-warning run is the only signal between "healthy" and
      // "everything refuses". Logging it at the boundary, on every admission
      // rather than only when the measurement is recomputed, is what makes the
      // approach to the ceiling observable instead of a step change.
      console.warn("[db-growth-fence] admitted with warning", {
        operation,
        databaseBytes: decision.databaseBytes,
        databaseBudgetBytes: decision.databaseBudgetBytes,
        warningRatio: DEFAULT_WARNING_RATIO,
        nearBudgetTables: FENCED_TABLES.filter(
          (table) =>
            (decision.tableBytes[table] ?? 0) >=
            DEFAULT_TABLE_BUDGET_BYTES[table] * DEFAULT_WARNING_RATIO,
        ),
        volumeHeadroom: evaluateVolumeHeadroom({ env }),
      });
    }
    store.__omniadsGrowthFence = {
      key: cacheKey,
      expiresAt: now() + ADMITTED_TTL_MS,
      decision,
    };
  } else {
    // Never cache a refusal.
    store.__omniadsGrowthFence = undefined;
    console.error("[db-growth-fence] boundary blocked", { operation, decision });
    throw new DbGrowthFenceRefusal(decision, operation);
  }
  return decision;
}
