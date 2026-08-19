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
  // large the first time. The ceiling exists to catch renewed
  // per-historical-day observation writing, not ordinary accretion.
  //
  // Raised from 4 GiB on 2026-08-18. The table reached 4,295,172,096 bytes -
  // 200 KB past the old ceiling - and the fence then refused every Meta ad and
  // campaign observation write from 2026-08-17 15:49 onward. Nothing reported
  // an outage: the native ad decision job kept succeeding, found no same-day
  // complete ad observation run to anchor to, and published
  // "native_account_manifest_incomplete", so the Decision Center quietly served
  // its Creatives scope from the legacy path instead.
  //
  // The runaway this guards against is absent - measured writes are ~200 rows
  // (~220 KB) a day, so 5 GiB is roughly a decade of headroom at the observed
  // rate while still refusing a genuine per-historical-day rewrite within days.
  // The structural fix is retention: 3.76M rows reach back to 2020-04-27 and
  // the decision path reads only recent state. That deletes history, so it is
  // an operator decision, not a default.
  meta_entity_state_history: 5 * 1024 ** 3, // live 4.11 GiB
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
 * headroom is a SEPARATE decision — see `evaluatePhysicalCapacity` — and is
 * taken from the database host's own telemetry, because this process cannot
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

/* ------------------------------------------------------------------------- *
 * Physical capacity admission
 * ------------------------------------------------------------------------- */

/**
 * Physical headroom is decided from the database host's own telemetry, not from
 * a value someone typed into the environment.
 *
 * The previous design took `SYNC_GROWTH_FENCE_VOLUME_AVAILABLE_BYTES` from the
 * environment. That is a number an operator transcribes once during a cutover
 * and then never again: it is unfalsifiable, it never ages, and it keeps
 * reporting a healthy volume for as long as the process lives. Worse, it made
 * physical safety an OPTIONAL input — absent it, the fence admitted on the
 * logical budget alone.
 *
 * `adsecute-db-healthcheck.timer` already samples `/var/lib/postgresql` every 15
 * minutes on the database host and writes it to `system_capacity_snapshots`.
 * That is a real, dated, host-produced measurement, and it is read in the SAME
 * statement as the logical sizes, so the physical and logical halves of one
 * decision can never come from two different moments.
 *
 * Every uncertainty refuses, and none of these refusals can be overridden. The
 * emergency override exists to let an operator push past a LOGICAL budget they
 * chose; it was never meant to authorise writing into a full disk.
 */
export const PHYSICAL_TELEMETRY_SOURCE = "db_host_healthcheck";

/** The PostgreSQL data directory. An exact path match, never a prefix. */
export const PHYSICAL_DATA_PATH = "/var/lib/postgresql";

/**
 * Freshness window: 35 minutes against a 15-minute sampler.
 *
 * Two samples may be missed before the fence closes, which absorbs a single
 * failed run and a restart without flapping. A third miss means the sampler is
 * not running, and at that point nothing knows the disk state.
 */
export const PHYSICAL_SNAPSHOT_MAX_AGE_MS = 35 * 60_000;

/**
 * Tolerance for a sample dated slightly in the future.
 *
 * After the producer fix the row's `sampled_at` is the DATABASE's
 * `clock_timestamp()` and so is the age computed here, which makes skew
 * structurally impossible. The tolerance covers rows written by the previous
 * producer, which stamped host time. It is three orders of magnitude below the
 * freshness window, so it cannot mask a stale sample.
 */
export const PHYSICAL_FUTURE_SKEW_TOLERANCE_MS = 60_000;

export type PhysicalCapacityReason =
  | "ok"
  | "telemetry_unavailable"
  | "snapshot_missing"
  | "snapshot_malformed"
  | "snapshot_future_dated"
  | "snapshot_stale"
  | "data_path_missing"
  | "database_identity_mismatch"
  | "free_space_low"
  | "projected_free_space_low";

export interface PhysicalCapacityDecision {
  admitted: boolean;
  reason: PhysicalCapacityReason;
  snapshotId: string | null;
  sampledAt: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  dataPath: string;
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  minimumFreeBytes: number;
  /**
   * Free bytes that would remain if the logical budget were consumed in full:
   * `available − max(budget − current, 0)`. This is what stops a raised budget
   * from authorising growth the volume cannot hold.
   */
  projectedFreeBytes: number | null;
  detail: string;
}

/** Raw shape as read from `system_capacity_snapshots`. */
export interface PhysicalCapacitySnapshotRow {
  id: string | null;
  sampledAt: string | null;
  ageSeconds: number | null;
  payload: unknown;
}

function physicalDenied(
  reason: Exclude<PhysicalCapacityReason, "ok">,
  detail: string,
  partial?: Partial<PhysicalCapacityDecision>,
): PhysicalCapacityDecision {
  return {
    admitted: false,
    reason,
    snapshotId: null,
    sampledAt: null,
    ageSeconds: null,
    maxAgeSeconds: PHYSICAL_SNAPSHOT_MAX_AGE_MS / 1000,
    dataPath: PHYSICAL_DATA_PATH,
    totalBytes: null,
    usedBytes: null,
    availableBytes: null,
    minimumFreeBytes: MINIMUM_VOLUME_FREE_BYTES,
    projectedFreeBytes: null,
    detail,
    ...partial,
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A byte count is only usable if it is a finite, non-negative, exact integer.
 *
 * `Number("12abc")` is NaN and `Number(null)` is 0 — the second is the dangerous
 * one, because a missing field would otherwise read as "zero bytes used" and
 * quietly pass a comparison. Strings of digits are accepted because JSON numbers
 * beyond 2^53 arrive as text from some drivers, and rejected the moment they
 * lose precision.
 */
function readByteCount(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "boolean") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (!Number.isSafeInteger(parsed)) return null;
  if (parsed < 0) return null;
  return parsed;
}

/**
 * Decide physical admission from one host telemetry row.
 *
 * Pure, so the real-PostgreSQL seam can seed fresh/low/stale/malformed/missing
 * rows and assert the exact reason each produces without mocking anything.
 */
export function evaluatePhysicalCapacity(input: {
  telemetryAvailable: boolean;
  snapshot: PhysicalCapacitySnapshotRow | null;
  databaseName: string | null;
  databaseBytes: number;
  databaseBudgetBytes: number;
}): PhysicalCapacityDecision {
  if (!input.telemetryAvailable) {
    return physicalDenied(
      "telemetry_unavailable",
      `system_capacity_snapshots is not readable; physical headroom for ${PHYSICAL_DATA_PATH} is unknown.`,
    );
  }
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.sampledAt == null) {
    return physicalDenied(
      "snapshot_missing",
      `No '${PHYSICAL_TELEMETRY_SOURCE}' sample exists. Confirm adsecute-db-healthcheck.timer is running on the database host.`,
    );
  }

  const payload = readObject(snapshot.payload);
  if (!payload) {
    return physicalDenied("snapshot_malformed", "Snapshot payload is not an object.", {
      snapshotId: snapshot.id,
      sampledAt: snapshot.sampledAt,
      ageSeconds: snapshot.ageSeconds,
    });
  }

  const base: Partial<PhysicalCapacityDecision> = {
    snapshotId: snapshot.id,
    sampledAt: snapshot.sampledAt,
    ageSeconds: snapshot.ageSeconds,
  };

  // Identity: a sample from a different database is a sample from a different
  // host, and its free space says nothing about this one.
  const database = readObject(payload.database);
  const snapshotDatabaseName =
    typeof database?.name === "string" ? database.name.trim() : "";
  if (!snapshotDatabaseName || snapshotDatabaseName !== (input.databaseName ?? "")) {
    return physicalDenied(
      "database_identity_mismatch",
      `Snapshot is for database '${snapshotDatabaseName || "unknown"}' but this process is connected to '${input.databaseName ?? "unknown"}'.`,
      base,
    );
  }

  const ageSeconds = snapshot.ageSeconds;
  if (ageSeconds == null || !Number.isFinite(ageSeconds)) {
    return physicalDenied(
      "snapshot_malformed",
      "Snapshot age could not be computed from sampled_at.",
      base,
    );
  }
  if (ageSeconds < -(PHYSICAL_FUTURE_SKEW_TOLERANCE_MS / 1000)) {
    return physicalDenied(
      "snapshot_future_dated",
      `Snapshot is dated ${Math.abs(ageSeconds).toFixed(0)}s in the future; a future-dated row would never age out.`,
      base,
    );
  }
  if (ageSeconds > PHYSICAL_SNAPSHOT_MAX_AGE_MS / 1000) {
    return physicalDenied(
      "snapshot_stale",
      `Snapshot is ${ageSeconds.toFixed(0)}s old, past the ${PHYSICAL_SNAPSHOT_MAX_AGE_MS / 1000}s window. The sampler is not running.`,
      base,
    );
  }

  const disks = Array.isArray(payload.disks) ? payload.disks : null;
  if (!disks) {
    return physicalDenied("snapshot_malformed", "Snapshot payload has no disks array.", base);
  }
  const disk = disks
    .map((entry) => readObject(entry))
    .find((entry) => entry != null && entry.path === PHYSICAL_DATA_PATH);
  if (!disk) {
    return physicalDenied(
      "data_path_missing",
      `Snapshot does not include the data path ${PHYSICAL_DATA_PATH}; the root filesystem is not a substitute for it.`,
      base,
    );
  }

  const totalBytes = readByteCount(disk.totalBytes);
  const usedBytes = readByteCount(disk.usedBytes);
  const availableBytes = readByteCount(disk.availableBytes);
  if (totalBytes == null || usedBytes == null || availableBytes == null) {
    return physicalDenied(
      "snapshot_malformed",
      `Disk measurement is not a set of non-negative integers (total=${String(disk.totalBytes)} used=${String(disk.usedBytes)} available=${String(disk.availableBytes)}).`,
      base,
    );
  }
  if (totalBytes <= 0 || usedBytes > totalBytes || availableBytes > totalBytes) {
    return physicalDenied(
      "snapshot_malformed",
      `Disk measurement is internally inconsistent (total=${totalBytes} used=${usedBytes} available=${availableBytes}).`,
      { ...base, totalBytes, usedBytes, availableBytes },
    );
  }

  const measured: Partial<PhysicalCapacityDecision> = {
    ...base,
    totalBytes,
    usedBytes,
    availableBytes,
  };

  if (availableBytes < MINIMUM_VOLUME_FREE_BYTES) {
    return physicalDenied(
      "free_space_low",
      `${availableBytes} bytes free on ${PHYSICAL_DATA_PATH}, below the ${MINIMUM_VOLUME_FREE_BYTES} byte floor.`,
      { ...measured, projectedFreeBytes: availableBytes },
    );
  }

  // The projected floor. Without it a raised logical budget — 300 GiB on a
  // volume with 100 GiB free — would authorise growth the disk cannot hold, and
  // the fence would keep admitting right up to the moment PostgreSQL stops.
  const remainingBudget = Math.max(input.databaseBudgetBytes - input.databaseBytes, 0);
  const projectedFreeBytes = availableBytes - remainingBudget;
  if (projectedFreeBytes < MINIMUM_VOLUME_FREE_BYTES) {
    return physicalDenied(
      "projected_free_space_low",
      `Consuming the remaining ${remainingBudget} bytes of logical budget would leave ${projectedFreeBytes} bytes free, below the ${MINIMUM_VOLUME_FREE_BYTES} byte floor. Lower the budget or add disk; do not raise the budget.`,
      { ...measured, projectedFreeBytes },
    );
  }

  return {
    admitted: true,
    reason: "ok",
    snapshotId: snapshot.id,
    sampledAt: snapshot.sampledAt,
    ageSeconds,
    maxAgeSeconds: PHYSICAL_SNAPSHOT_MAX_AGE_MS / 1000,
    dataPath: PHYSICAL_DATA_PATH,
    totalBytes,
    usedBytes,
    availableBytes,
    minimumFreeBytes: MINIMUM_VOLUME_FREE_BYTES,
    projectedFreeBytes,
    detail: `${availableBytes} bytes free on ${PHYSICAL_DATA_PATH}, sampled ${ageSeconds.toFixed(0)}s ago.`,
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
  | "fence_read_failed"
  | "physical_telemetry_unavailable"
  | "physical_snapshot_missing"
  | "physical_snapshot_malformed"
  | "physical_snapshot_future_dated"
  | "physical_snapshot_stale"
  | "physical_data_path_missing"
  | "physical_database_identity_mismatch"
  | "physical_free_space_low"
  | "physical_projected_free_space_low";

const PHYSICAL_FENCE_REASON: Record<
  Exclude<PhysicalCapacityReason, "ok">,
  DbGrowthFenceReason
> = {
  telemetry_unavailable: "physical_telemetry_unavailable",
  snapshot_missing: "physical_snapshot_missing",
  snapshot_malformed: "physical_snapshot_malformed",
  snapshot_future_dated: "physical_snapshot_future_dated",
  snapshot_stale: "physical_snapshot_stale",
  data_path_missing: "physical_data_path_missing",
  database_identity_mismatch: "physical_database_identity_mismatch",
  free_space_low: "physical_free_space_low",
  projected_free_space_low: "physical_projected_free_space_low",
};

/** Refusals no emergency override may admit past. */
export const NON_OVERRIDABLE_FENCE_REASONS: ReadonlySet<DbGrowthFenceReason> = new Set(
  Object.values(PHYSICAL_FENCE_REASON),
);

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
  /** Host-volume admission, measured in the same roundtrip. Never overridable. */
  physical: PhysicalCapacityDecision | null;
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
  databaseBytes?: number | null;
  physical?: PhysicalCapacityDecision | null;
}): DbGrowthFenceDecision {
  return {
    allowed: false,
    reason: input.reason,
    warning: false,
    databaseBytes: input.databaseBytes ?? null,
    databaseBudgetBytes: input.budget,
    tableBytes: {},
    offender: null,
    evaluatedAt: input.evaluatedAt,
    errorMessage: input.errorMessage ?? null,
    overridden: false,
    physical: input.physical ?? null,
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
    // ONE statement. The logical sizes and the host's physical telemetry are
    // read together against one connection at one instant, so the two halves of
    // the decision can never describe different moments or different databases.
    // `measured` is referenced twice, so PostgreSQL materialises it and
    // clock_timestamp() is evaluated exactly once for the whole row set.
    rows = (await sql.query(
      `
      WITH measured AS (SELECT clock_timestamp() AS at),
      fenced AS (
        SELECT
          t.table_name,
          CASE
            WHEN to_regclass('public.' || t.table_name) IS NULL THEN NULL
            ELSE pg_total_relation_size(to_regclass('public.' || t.table_name))::bigint
          END AS table_bytes
        FROM unnest($1::text[]) AS t(table_name)
      ),
      latest_capacity AS (
        SELECT s.id, s.sampled_at, s.payload
        FROM system_capacity_snapshots s
        WHERE s.source = $2
        ORDER BY s.sampled_at DESC, s.id DESC
        LIMIT 1
      )
      SELECT
        pg_database_size(current_database())::bigint AS database_bytes,
        current_database() AS database_name,
        fenced.table_name,
        fenced.table_bytes,
        capacity.id::text AS capacity_id,
        capacity.sampled_at AS capacity_sampled_at,
        CASE
          WHEN capacity.sampled_at IS NULL THEN NULL
          ELSE EXTRACT(EPOCH FROM ((SELECT at FROM measured) - capacity.sampled_at))
        END AS capacity_age_seconds,
        capacity.payload AS capacity_payload
      FROM fenced
      LEFT JOIN latest_capacity capacity ON TRUE
    `,
      [[...FENCED_TABLES], PHYSICAL_TELEMETRY_SOURCE],
    )) as Array<Record<string, unknown>>;
  } catch (error) {
    // An unreadable fence is not permission to write. A missing telemetry table
    // is called out separately because the remedy is different: the sampler
    // needs deploying, not the database investigating. The statement is parsed
    // as a whole, so an absent relation surfaces here rather than as a value.
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "42P01" && message.includes("system_capacity_snapshots")) {
      return denied({
        reason: "physical_telemetry_unavailable",
        budget: databaseBudget,
        errorMessage: message,
        evaluatedAt,
        physical: evaluatePhysicalCapacity({
          telemetryAvailable: false,
          snapshot: null,
          databaseName: null,
          databaseBytes: 0,
          databaseBudgetBytes: databaseBudget,
        }),
      });
    }
    return denied({
      reason: "fence_read_failed",
      budget: databaseBudget,
      errorMessage: message,
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

  // Physical admission, from the same row set. Evaluated BEFORE the logical
  // budget so that a refusal here cannot be reached by the emergency override
  // below: that override exists to push past a budget an operator chose, not to
  // authorise writing into a full disk.
  const head = rows[0] ?? {};
  const rawSampledAt = head.capacity_sampled_at;
  const physical = evaluatePhysicalCapacity({
    telemetryAvailable: true,
    snapshot:
      head.capacity_id == null && rawSampledAt == null
        ? null
        : {
            id: head.capacity_id == null ? null : String(head.capacity_id),
            sampledAt:
              rawSampledAt instanceof Date
                ? rawSampledAt.toISOString()
                : rawSampledAt == null
                  ? null
                  : String(rawSampledAt),
            ageSeconds:
              head.capacity_age_seconds == null
                ? null
                : Number(head.capacity_age_seconds),
            payload: head.capacity_payload,
          },
    databaseName: head.database_name == null ? null : String(head.database_name),
    databaseBytes,
    databaseBudgetBytes: databaseBudget,
  });
  if (!physical.admitted) {
    const reason = PHYSICAL_FENCE_REASON[physical.reason as Exclude<PhysicalCapacityReason, "ok">];
    console.error("[db-growth-fence] refused on physical capacity", {
      reason,
      detail: physical.detail,
      sampledAt: physical.sampledAt,
      ageSeconds: physical.ageSeconds,
    });
    return denied({
      reason,
      budget: databaseBudget,
      errorMessage: physical.detail,
      evaluatedAt,
      databaseBytes,
      physical,
    });
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
        physical,
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
      physical,
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
    physical,
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
        physical: decision.physical,
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

    // A SINGLE relation over budget refuses that relation's provider, not every
    // provider.
    //
    // The per-table ceilings exist, in this file's own words, "to catch a single
    // relation running away inside" the aggregate. Refusing all sync for one of
    // them is wider than that purpose and it cost a full outage: measured
    // 2026-08-08, meta_entity_state_history sat 208 KB (0.005%) over its 4 GiB
    // ceiling and Google Ads and Shopify sync - which cannot write a byte of
    // that table - were stopped alongside Meta for 26 hours.
    //
    // The aggregate database budget is untouched by this and still refuses
    // everything, because there the whole database is the thing at risk.
    //
    // Fail-closed is preserved by requiring positive proof of non-involvement:
    // the offender's family AND the operation's family must both be known AND
    // differ. An unrecognised operation label, an unrecognised table, or the
    // aggregate breach all fall through to the refusal exactly as before.
    const offenderTable = decision.offender?.table;
    const offenderFamily =
      decision.reason === "table_budget_exceeded" && offenderTable && offenderTable !== "database"
        ? fencedTableProviderFamily(offenderTable as FencedTable)
        : null;
    const operationFamily = operationProviderFamily(operation);
    const collateralOnly =
      offenderFamily != null && operationFamily != null && operationFamily !== offenderFamily;

    if (collateralOnly) {
      console.warn("[db-growth-fence] admitted outside the offending provider", {
        operation,
        operationFamily,
        offender: decision.offender,
        reason: decision.reason,
      });
      return { ...decision, allowed: true, warning: true };
    }

    console.error("[db-growth-fence] boundary blocked", { operation, decision });
    throw new DbGrowthFenceRefusal(decision, operation);
  }
  return decision;
}

/** The provider whose sync writes a fenced relation, or null if unrecognised. */
export function fencedTableProviderFamily(
  table: FencedTable,
): "meta" | "google_ads" | "shopify" | null {
  if (table.startsWith("meta_")) return "meta";
  if (table.startsWith("shopify_")) return "shopify";
  if (table.startsWith("google_ads_")) return "google_ads";
  return null;
}

/**
 * The provider a boundary label belongs to, or null when it cannot be proven.
 *
 * Null is the safe answer and the caller treats it as "may touch anything", so
 * a new label added without thought refuses rather than slips through.
 */
export function operationProviderFamily(
  operation: string,
): "meta" | "google_ads" | "shopify" | null {
  if (operation.startsWith("meta")) return "meta";
  if (operation.startsWith("shopify")) return "shopify";
  // Both `google_ads_*` and the older `google_*` labels are Google Ads sync.
  if (operation.startsWith("google")) return "google_ads";
  return null;
}
