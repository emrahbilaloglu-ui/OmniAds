import { FENCED_TABLES, type DbGrowthFenceDecision } from "./db-growth-fence";

/** Maintenance is a separate executor class. This never changes business
 * admission, the DB budget, provider flags or the emergency override. DELETE
 * and ordinary VACUUM still consume WAL/VM/FSM space; they are not zero-I/O. */
export const NATIVE_STORAGE_MAINTENANCE_CONTRACT = "native-storage-maintenance-admission.v1" as const;
export const NATIVE_STORAGE_OPERATIONS = ["read-original", "publish-original", "activate-root",
  "retire-original", "vacuum-main", "vacuum-toast"] as const;
export type NativeStorageOperation = typeof NATIVE_STORAGE_OPERATIONS[number];
const MiB = 1024 * 1024;
const MAX_AGE_MS = 60_000;
const RESERVE = 512 * MiB;
const MIN_APP_FREE = 2 * 1024 * MiB;
const MIN_DB_FREE = 40 * 1024 * MiB;

export interface NativeStorageMaintenanceEvidence {
  operation: NativeStorageOperation;
  observedAt: string;
  sourceManifestSha256: string;
  actualSourceReviewSha256: string;
  sourceMatches: boolean;
  exactRolesAndReaderRootMatch: boolean;
  unknownDatabaseConsumers: number;
  nativeProducerIdle: boolean;
  originalRows: number;
  originalContexts: number;
  /** Actual bytes of the already-serialized immutable publication, not a
   * caller's prediction of database growth or a general zero-byte exemption. */
  serializedArchiveBytes: number;
  appVolume: { observedAt: string; availableBytes: number; minimumFreeBytes: number };
  walVolume: { observedAt: string; availableBytes: number; minimumFreeBytes: number };
  independentOriginalRestoreMatches: boolean;
  completeOriginalCopiesMatch: boolean;
  freshHistoricalHttpMatches: boolean;
  selectedPinClosureMatches: boolean;
  alreadyAbsentWithEnforcedLineage: boolean;
}

const digest = (v: string) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const bytes = (v: number) => Number.isSafeInteger(v) && v >= 0;
const fresh = (v: string, now: number) => Number.isFinite(Date.parse(v)) &&
  Date.parse(v) <= now && now - Date.parse(v) <= MAX_AGE_MS;

export function assessNativeStorageMaintenanceAdmission(input: {
  business: Readonly<DbGrowthFenceDecision>;
  evidence: Readonly<NativeStorageMaintenanceEvidence>;
  expectedDatabaseBudgetBytes: number;
  nowMs: number;
}) {
  const { business: b, evidence: e, nowMs: now } = input;
  const issues: string[] = [];
  const ready = b.allowed === true && b.reason === "ready" && b.offender === null;
  const onlyDatabaseBudget = b.allowed === false && b.reason === "database_budget_exceeded" &&
    b.offender?.table === "database" && b.offender.bytes === b.databaseBytes &&
    b.offender.budget === b.databaseBudgetBytes && b.databaseBytes !== null &&
    b.databaseBytes >= b.databaseBudgetBytes;
  if (!Number.isFinite(now) || !fresh(b.evaluatedAt, now) || !fresh(e.observedAt, now)) issues.push("stale_measurement");
  if (!bytes(input.expectedDatabaseBudgetBytes) || input.expectedDatabaseBudgetBytes === 0 ||
      b.databaseBudgetBytes !== input.expectedDatabaseBudgetBytes || !bytes(b.databaseBytes ?? -1) ||
      ready && b.databaseBytes! >= b.databaseBudgetBytes || b.overridden !== false || b.errorMessage !== null ||
      !(ready || onlyDatabaseBudget)) issues.push("business_fence_not_supported");
  const tableBudgets = Object.entries(b.tableBudgetBytes ?? {});
  if (tableBudgets.length !== FENCED_TABLES.length ||
    FENCED_TABLES.some(name => !Object.hasOwn(b.tableBudgetBytes ?? {}, name)) || tableBudgets.some(([name, budget]) =>
    !bytes(budget ?? -1) || budget! <= 0 || !bytes(b.tableBytes[name as keyof typeof b.tableBytes] ?? -1) ||
    b.tableBytes[name as keyof typeof b.tableBytes]! >= budget!)) issues.push("independent_table_fence");
  // The global physical fence already includes its independent floor and
  // projected-budget check. Keep both and add a finite maintenance WAL reserve.
  const p = b.physical;
  if (!p || p.admitted !== true || p.reason !== "ok" || !fresh(p.sampledAt ?? "", now) ||
      !bytes(p.minimumFreeBytes) || p.minimumFreeBytes < MIN_DB_FREE || !bytes(p.availableBytes ?? -1) ||
      !bytes(p.projectedFreeBytes ?? -1) || p.availableBytes! < p.minimumFreeBytes + RESERVE ||
      p.projectedFreeBytes! < p.minimumFreeBytes + RESERVE) issues.push("database_physical_reserve");
  for (const [label, v] of [["app", e.appVolume], ["wal", e.walVolume]] as const) {
    if (!v || !fresh(v.observedAt, now) || !bytes(v.availableBytes) || !bytes(v.minimumFreeBytes) ||
        v.minimumFreeBytes < MIN_APP_FREE || v.availableBytes < v.minimumFreeBytes + RESERVE +
          (label === "app" ? e.serializedArchiveBytes : 0)) issues.push(`${label}_physical_reserve`);
  }
  if (!NATIVE_STORAGE_OPERATIONS.includes(e.operation) || !digest(e.sourceManifestSha256) ||
      !digest(e.actualSourceReviewSha256) || e.sourceMatches !== true ||
      e.exactRolesAndReaderRootMatch !== true || e.unknownDatabaseConsumers !== 0)
    issues.push("exact_reviewed_operation_required");
  if (!Number.isInteger(e.originalRows) || e.originalRows < 1 || e.originalRows > 1134 ||
      !Number.isInteger(e.originalContexts) || e.originalContexts < 1 || e.originalContexts > 4 ||
      !bytes(e.serializedArchiveBytes) || e.serializedArchiveBytes > 32 * MiB)
    issues.push("finite_original_scope");
  if (e.operation !== "read-original" && e.nativeProducerIdle !== true) issues.push("producer_not_idle");
  if (e.operation !== "read-original" && (e.independentOriginalRestoreMatches !== true ||
      e.completeOriginalCopiesMatch !== true)) issues.push("original_restore_or_copies_missing");
  if (e.operation === "retire-original" && (e.freshHistoricalHttpMatches !== true ||
      e.selectedPinClosureMatches !== true)) issues.push("serving_or_pin_proof_missing");
  if ((e.operation === "vacuum-main" || e.operation === "vacuum-toast") &&
      e.alreadyAbsentWithEnforcedLineage !== true) issues.push("absence_not_proved");
  return { contract: NATIVE_STORAGE_MAINTENANCE_CONTRACT, admitted: issues.length === 0, issues,
    operation: e.operation, businessAllowed: b.allowed, businessReason: b.reason,
    businessDecisionUnchanged: true as const, databaseBudgetBytes: b.databaseBudgetBytes,
    overridden: false as const, providerAuthority: false as const,
    physicalBytesReclaimed: 0 as const, sustainableStorageClosed: false as const };
}
