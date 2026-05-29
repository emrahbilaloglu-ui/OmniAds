import { execFile } from "node:child_process";
import { hostname, platform } from "node:os";
import { promisify } from "node:util";
import { getDbWithTimeout } from "@/lib/db";

const execFileAsync = promisify(execFile);

const DEFAULT_WARN_PERCENT = 85;
const DEFAULT_CRITICAL_PERCENT = 95;
const DEFAULT_DISK_PATHS = ["/"];
const DEFAULT_DB_TIMEOUT_MS = 15_000;
const DEFAULT_DF_TIMEOUT_MS = 4_000;
const DEFAULT_SSH_TIMEOUT_MS = 6_000;
const DEFAULT_ADSECUTE_PROD_SSH_HOST = "root@178.156.222.119";
const DEFAULT_DB_HOST_SNAPSHOT_MAX_AGE_MINUTES = 60;

export type SystemCapacityStatus = "ok" | "warning" | "critical" | "unknown";

export interface SystemCapacityThresholds {
  warningPercent: number;
  criticalPercent: number;
}

export interface AdminDatabaseRelationCapacity {
  schema: string;
  relation: string;
  relationKind: "table" | "materialized_view" | "other";
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
}

export interface AdminDatabaseCapacity {
  databaseName: string;
  userName: string;
  serverAddress: string | null;
  serverPort: number | null;
  sizeBytes: number;
  sizePretty: string;
  topRelations: AdminDatabaseRelationCapacity[];
}

export interface AdminDiskCapacity {
  path: string;
  filesystem: string | null;
  mountedOn: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  usedPercent: number | null;
  status: SystemCapacityStatus;
  source: "df" | "db_host_healthcheck" | "prod_host_ssh";
  host: string | null;
  error: string | null;
}

export interface AdminSystemCapacityPayload {
  sampledAt: string;
  status: SystemCapacityStatus;
  thresholds: SystemCapacityThresholds;
  database: AdminDatabaseCapacity;
  dbHostDisks: AdminDiskCapacity[];
  runtimeDisks: AdminDiskCapacity[];
  runtimeDiskSource: "local_runtime" | "prod_host_ssh";
  runtimeHost: string | null;
  runtimePlatform: NodeJS.Platform;
  runtimeIsProdServer: boolean;
  disks: AdminDiskCapacity[];
  diskSource: "local_runtime" | "db_host_healthcheck";
  diskSnapshotAt: string | null;
  notes: string[];
}

export interface AdminSystemCapacitySummary {
  status: SystemCapacityStatus;
  databaseSizeBytes: number;
  databaseSizePretty: string;
  diskUsedPercent: number | null;
  diskAvailableBytes: number | null;
  diskPath: string | null;
  diskStatus: SystemCapacityStatus;
  topRelation: string | null;
}

interface RawDatabaseCapacityRow {
  database_name: string;
  user_name: string;
  server_addr: string | null;
  server_port: number | string | null;
  database_bytes: number | string;
  database_size: string;
}

interface RawRelationCapacityRow {
  schema_name: string;
  relation_name: string;
  relation_kind: "r" | "m" | string;
  total_bytes: number | string;
  table_bytes: number | string;
  index_bytes: number | string;
}

interface RawCapacitySnapshotRow {
  sampled_at: string;
  payload: unknown;
}

interface DbHostCapacitySnapshot {
  sampledAt: string;
  hostname: string | null;
  disks: AdminDiskCapacity[];
  stale: boolean;
}

function parsePositivePercent(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : fallback;
}

function resolveThresholds(env: NodeJS.ProcessEnv = process.env): SystemCapacityThresholds {
  const warningPercent = parsePositivePercent(
    env.ADMIN_SYSTEM_CAPACITY_WARN_PCT ?? env.DISK_WARN_PCT,
    DEFAULT_WARN_PERCENT,
  );
  const criticalPercent = parsePositivePercent(
    env.ADMIN_SYSTEM_CAPACITY_CRITICAL_PCT ?? env.DISK_FAIL_PCT,
    DEFAULT_CRITICAL_PERCENT,
  );
  return {
    warningPercent,
    criticalPercent: Math.max(criticalPercent, warningPercent),
  };
}

function resolveDiskPaths(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.ADMIN_SYSTEM_CAPACITY_DISK_PATHS?.trim();
  const paths = raw
    ? raw.split(",").map((path) => path.trim()).filter(Boolean)
    : DEFAULT_DISK_PATHS;
  return Array.from(new Set(paths));
}

function resolveDbHostSnapshotMaxAgeMs(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Number(env.ADMIN_SYSTEM_CAPACITY_DB_SNAPSHOT_MAX_AGE_MINUTES);
  const minutes =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_DB_HOST_SNAPSHOT_MAX_AGE_MINUTES;
  return minutes * 60 * 1000;
}

function resolveProdServerSshHost(env: NodeJS.ProcessEnv = process.env) {
  const explicit =
    env.ADMIN_SYSTEM_CAPACITY_PROD_SSH_HOST?.trim() ??
    env.LOCAL_SYNC_SOURCE_SSH_HOST?.trim();
  if (explicit) return explicit;
  if (platform() === "darwin" && env.NODE_ENV !== "production") {
    return DEFAULT_ADSECUTE_PROD_SSH_HOST;
  }
  return null;
}

function createUnavailableDbHostDisk(
  error: string,
  host: string | null,
  path = "/var/lib/postgresql",
): AdminDiskCapacity {
  return {
    path,
    filesystem: null,
    mountedOn: null,
    totalBytes: null,
    usedBytes: null,
    availableBytes: null,
    usedPercent: null,
    status: "unknown",
    source: "db_host_healthcheck",
    host,
    error,
  };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function classifyCapacityStatus(
  usedPercent: number | null | undefined,
  thresholds: SystemCapacityThresholds,
): SystemCapacityStatus {
  if (usedPercent == null || !Number.isFinite(usedPercent)) return "unknown";
  if (usedPercent >= thresholds.criticalPercent) return "critical";
  if (usedPercent >= thresholds.warningPercent) return "warning";
  return "ok";
}

function combineStatuses(statuses: SystemCapacityStatus[]): SystemCapacityStatus {
  if (statuses.includes("critical")) return "critical";
  if (statuses.includes("warning")) return "warning";
  if (statuses.every((status) => status === "unknown")) return "unknown";
  if (statuses.includes("unknown")) return "warning";
  return "ok";
}

function toNumber(value: number | string | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRelationKind(kind: string): AdminDatabaseRelationCapacity["relationKind"] {
  if (kind === "r") return "table";
  if (kind === "m") return "materialized_view";
  return "other";
}

export function parseDfOutput(
  path: string,
  output: string,
  thresholds: SystemCapacityThresholds,
): AdminDiskCapacity {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const dataLine = lines.find((line) => !line.toLowerCase().startsWith("filesystem"));
  if (!dataLine) {
    return {
      path,
      filesystem: null,
      mountedOn: null,
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      usedPercent: null,
      status: "unknown",
      source: "df",
      host: null,
      error: "df returned no data rows",
    };
  }

  const parts = dataLine.split(/\s+/);
  const totalBlocks = Number(parts[1]);
  const usedBlocks = Number(parts[2]);
  const availableBlocks = Number(parts[3]);
  const usedPercent = Number(String(parts[4] ?? "").replace("%", ""));
  const mountedOn = parts.slice(5).join(" ") || null;

  if (
    parts.length < 5 ||
    !Number.isFinite(totalBlocks) ||
    !Number.isFinite(usedBlocks) ||
    !Number.isFinite(availableBlocks) ||
    !Number.isFinite(usedPercent)
  ) {
    return {
      path,
      filesystem: parts[0] ?? null,
      mountedOn,
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      usedPercent: null,
      status: "unknown",
      source: "df",
      host: null,
      error: `Could not parse df output for ${path}`,
    };
  }

  return {
    path,
    filesystem: parts[0] ?? null,
    mountedOn,
    totalBytes: totalBlocks * 1024,
    usedBytes: usedBlocks * 1024,
    availableBytes: availableBlocks * 1024,
    usedPercent,
    status: classifyCapacityStatus(usedPercent, thresholds),
    source: "df",
    host: null,
    error: null,
  };
}

async function getDiskCapacityForPath(
  path: string,
  thresholds: SystemCapacityThresholds,
): Promise<AdminDiskCapacity> {
  try {
    const { stdout } = await execFileAsync("df", ["-Pk", path], {
      timeout: DEFAULT_DF_TIMEOUT_MS,
      maxBuffer: 4_096,
    });
    return {
      ...parseDfOutput(path, stdout, thresholds),
      host: hostname() || null,
    };
  } catch (error) {
    return {
      path,
      filesystem: null,
      mountedOn: null,
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      usedPercent: null,
      status: "unknown",
      source: "df",
      host: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getProdServerDiskCapacityForPath(
  sshHost: string,
  path: string,
  thresholds: SystemCapacityThresholds,
): Promise<{ disk: AdminDiskCapacity; host: string | null; remotePlatform: NodeJS.Platform }> {
  try {
    const command = [
      "hostname",
      "uname -s",
      `df -Pk ${shellQuote(path)}`,
    ].join(" && ");
    const { stdout } = await execFileAsync("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=4",
      sshHost,
      command,
    ], {
      timeout: DEFAULT_SSH_TIMEOUT_MS,
      maxBuffer: 8_192,
    });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const remoteHost = lines[0]?.trim() || sshHost;
    const remotePlatform = lines[1]?.trim().toLowerCase() === "darwin" ? "darwin" : "linux";
    const dfOutput = lines.slice(2).join("\n");
    const disk = parseDfOutput(path, dfOutput, thresholds);
    return {
      disk: {
        ...disk,
        source: "prod_host_ssh",
        host: remoteHost,
      },
      host: remoteHost,
      remotePlatform,
    };
  } catch (error) {
    return {
      disk: {
        path,
        filesystem: null,
        mountedOn: null,
        totalBytes: null,
        usedBytes: null,
        availableBytes: null,
        usedPercent: null,
        status: "unknown",
        source: "prod_host_ssh",
        host: sshHost,
        error: error instanceof Error ? error.message : String(error),
      },
      host: sshHost,
      remotePlatform: "linux",
    };
  }
}

async function getRuntimeDiskCapacity(
  diskPaths: string[],
  thresholds: SystemCapacityThresholds,
  env: NodeJS.ProcessEnv,
) {
  const prodSshHost = resolveProdServerSshHost(env);
  if (prodSshHost) {
    const remoteDisks = await Promise.all(
      diskPaths.map((path) => getProdServerDiskCapacityForPath(prodSshHost, path, thresholds)),
    );
    return {
      disks: remoteDisks.map((entry) => entry.disk),
      source: "prod_host_ssh" as const,
      host: remoteDisks.find((entry) => entry.host)?.host ?? prodSshHost,
      runtimePlatform: remoteDisks.find((entry) => entry.remotePlatform)?.remotePlatform ?? "linux",
    };
  }

  const disks = await Promise.all(diskPaths.map((path) => getDiskCapacityForPath(path, thresholds)));
  return {
    disks,
    source: "local_runtime" as const,
    host: hostname() || null,
    runtimePlatform: platform(),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNullableNumber(value: unknown) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceDbHostSnapshot(
  row: RawCapacitySnapshotRow | undefined,
  thresholds: SystemCapacityThresholds,
): DbHostCapacitySnapshot | null {
  if (!row) return null;
  const payload = readRecord(row.payload);
  if (!payload) return null;
  const rawDisks = Array.isArray(payload.disks) ? payload.disks : [];
  const hostname = readString(payload.hostname);
  const disks: AdminDiskCapacity[] = [];
  for (const rawDisk of rawDisks) {
    const disk = readRecord(rawDisk);
    if (!disk) continue;
    const usedPercent = readNullableNumber(disk.usedPercent);
    disks.push({
      path: readString(disk.path) ?? "unknown",
      filesystem: readString(disk.filesystem),
      mountedOn: readString(disk.mountedOn),
      totalBytes: readNullableNumber(disk.totalBytes),
      usedBytes: readNullableNumber(disk.usedBytes),
      availableBytes: readNullableNumber(disk.availableBytes),
      usedPercent,
      status: classifyCapacityStatus(usedPercent, thresholds),
      source: "db_host_healthcheck" as const,
      host: hostname,
      error: null,
    });
  }

  if (!disks.length) return null;
  return {
    sampledAt: readString(payload.sampledAt) ?? row.sampled_at,
    hostname,
    disks,
    stale: false,
  };
}

async function getLatestDbHostCapacitySnapshot(
  thresholds: SystemCapacityThresholds,
  maxAgeMs: number,
): Promise<DbHostCapacitySnapshot | null> {
  const sql = getDbWithTimeout(DEFAULT_DB_TIMEOUT_MS);
  const tableRows = await sql.query<{ exists: boolean }>(
    "SELECT to_regclass('public.system_capacity_snapshots') IS NOT NULL AS exists",
  );
  if (!tableRows[0]?.exists) return null;

  const rows = await sql.query<RawCapacitySnapshotRow>(`
    SELECT sampled_at, payload
    FROM system_capacity_snapshots
    WHERE source = 'db_host_healthcheck'
    ORDER BY sampled_at DESC
    LIMIT 1
  `);
  const snapshot = coerceDbHostSnapshot(rows[0], thresholds);
  if (!snapshot) return null;

  const sampledAtMs = Date.parse(snapshot.sampledAt);
  const ageMs = Number.isFinite(sampledAtMs) ? Date.now() - sampledAtMs : Number.POSITIVE_INFINITY;
  if (ageMs <= maxAgeMs) return snapshot;

  return {
    ...snapshot,
    stale: true,
    disks: snapshot.disks.map((disk) => ({
      ...disk,
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      usedPercent: null,
      status: "unknown",
      error: `DB host snapshot is stale; last sample was ${snapshot.sampledAt}.`,
    })),
  };
}

async function getDatabaseCapacity(relationLimit: number): Promise<AdminDatabaseCapacity> {
  const sql = getDbWithTimeout(DEFAULT_DB_TIMEOUT_MS);
  const [databaseRows, relationRows] = await Promise.all([
    sql.query<RawDatabaseCapacityRow>(`
      SELECT
        current_database() AS database_name,
        current_user AS user_name,
        inet_server_addr()::text AS server_addr,
        inet_server_port() AS server_port,
        pg_database_size(current_database())::bigint AS database_bytes,
        pg_size_pretty(pg_database_size(current_database())) AS database_size
    `),
    relationLimit > 0
      ? sql.query<RawRelationCapacityRow>(`
          SELECT
            n.nspname AS schema_name,
            c.relname AS relation_name,
            c.relkind AS relation_kind,
            pg_total_relation_size(c.oid)::bigint AS total_bytes,
            pg_relation_size(c.oid)::bigint AS table_bytes,
            GREATEST(pg_total_relation_size(c.oid) - pg_relation_size(c.oid), 0)::bigint AS index_bytes
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND c.relkind IN ('r', 'm')
          ORDER BY pg_total_relation_size(c.oid) DESC, n.nspname ASC, c.relname ASC
          LIMIT ${Math.max(1, Math.min(50, relationLimit))}
        `)
      : Promise.resolve([]),
  ]);

  const database = databaseRows[0];
  if (!database) {
    throw new Error("Database capacity query returned no rows.");
  }

  return {
    databaseName: database.database_name,
    userName: database.user_name,
    serverAddress: database.server_addr,
    serverPort: database.server_port == null ? null : toNumber(database.server_port),
    sizeBytes: toNumber(database.database_bytes),
    sizePretty: database.database_size,
    topRelations: relationRows.map((row) => ({
      schema: row.schema_name,
      relation: row.relation_name,
      relationKind: normalizeRelationKind(row.relation_kind),
      totalBytes: toNumber(row.total_bytes),
      tableBytes: toNumber(row.table_bytes),
      indexBytes: toNumber(row.index_bytes),
    })),
  };
}

export async function getAdminSystemCapacity(options?: {
  relationLimit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<AdminSystemCapacityPayload> {
  const env = options?.env ?? process.env;
  const thresholds = resolveThresholds(env);
  const diskPaths = resolveDiskPaths(env);
  const dbHostSnapshotMaxAgeMs = resolveDbHostSnapshotMaxAgeMs(env);
  const [database, runtimeCapacity, dbHostSnapshot] = await Promise.all([
    getDatabaseCapacity(options?.relationLimit ?? 10),
    getRuntimeDiskCapacity(diskPaths, thresholds, env),
    getLatestDbHostCapacitySnapshot(thresholds, dbHostSnapshotMaxAgeMs).catch(() => null),
  ]);
  const dbHostDisks =
    dbHostSnapshot?.disks ??
    [createUnavailableDbHostDisk("DB host disk snapshot is unavailable.", null)];
  const runtimeDisks = runtimeCapacity.disks;
  const disks = dbHostDisks;
  const diskSource = "db_host_healthcheck";
  const dbDiskStatus = combineStatuses(disks.map((disk) => disk.status));
  const runtimeDiskStatus = combineStatuses(runtimeDisks.map((disk) => disk.status));
  const status = combineStatuses([dbDiskStatus, runtimeDiskStatus]);
  const unavailableDbDiskPaths = disks
    .filter((disk) => disk.status === "unknown")
    .map((disk) => disk.path);
  const unavailableRuntimeDiskPaths = runtimeDisks
    .filter((disk) => disk.status === "unknown")
    .map((disk) => disk.path);

  return {
    sampledAt: new Date().toISOString(),
    status,
    thresholds,
    database,
    dbHostDisks,
    runtimeDisks,
    runtimeDiskSource: runtimeCapacity.source,
    runtimeHost: runtimeCapacity.host,
    runtimePlatform: runtimeCapacity.runtimePlatform,
    runtimeIsProdServer: runtimeCapacity.source === "prod_host_ssh" || env.NODE_ENV === "production",
    disks,
    diskSource,
    diskSnapshotAt: dbHostSnapshot?.sampledAt ?? null,
    notes: [
      ...(!dbHostSnapshot
        ? ["DB host disk snapshot is unavailable; DB host telemetry is unknown."]
        : []),
      ...(dbHostSnapshot?.stale
        ? [`DB host disk snapshot is stale; last sample was ${dbHostSnapshot.sampledAt}.`]
        : []),
      ...(unavailableDbDiskPaths.length
        ? [`DB host disk path unavailable: ${unavailableDbDiskPaths.join(", ")}`]
        : []),
      ...(unavailableRuntimeDiskPaths.length
        ? [`Runtime disk path unavailable: ${unavailableRuntimeDiskPaths.join(", ")}`]
        : []),
    ],
  };
}

export function summarizeAdminSystemCapacity(
  payload: AdminSystemCapacityPayload,
): AdminSystemCapacitySummary {
  const primaryDisk =
    payload.disks.find((disk) => disk.path === "/var/lib/postgresql") ??
    payload.disks.find((disk) => disk.status !== "unknown") ??
    payload.disks[0] ??
    null;
  const topRelation = payload.database.topRelations[0];

  return {
    status: payload.status,
    databaseSizeBytes: payload.database.sizeBytes,
    databaseSizePretty: payload.database.sizePretty,
    diskUsedPercent: primaryDisk?.usedPercent ?? null,
    diskAvailableBytes: primaryDisk?.availableBytes ?? null,
    diskPath: primaryDisk?.path ?? null,
    diskStatus: primaryDisk?.status ?? "unknown",
    topRelation: topRelation ? `${topRelation.schema}.${topRelation.relation}` : null,
  };
}
