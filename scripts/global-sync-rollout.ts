/**
 * Executable global rollout orchestration.
 *
 * The runbook described these steps; nothing enforced them. A runbook is a
 * checklist a tired operator can skip a line of, and the one line worth
 * skipping is always the one that would have caught the problem. This performs
 * or verifies each precondition and refuses to continue when one fails.
 *
 * Two properties matter more than convenience:
 *
 *  - It ABORTS on any failed precondition. There is no --force, no --skip, and
 *    no partial-credit path.
 *  - The enable step is ATOMIC. Either every sync lane is written, or none is.
 *    A half-enabled deployment — Meta on, Google off — is a state nobody has
 *    reasoned about, and it is exactly what a sequence of manual exports
 *    produces when one of them fails.
 *
 * Retention is never enabled by this script under any flag. It is the only path
 * that deletes and its first production run is a separate argument.
 *
 * Commands:
 *   preflight  read-only: report every precondition, change nothing
 *   enable     verify every precondition, then atomically enable the sync lanes
 *   disable    atomically clear every lane, including retention
 *
 * DOES NOT deploy, migrate, or restart anything. It verifies that those were
 * done and it flips the switch. Running `enable` against production is a
 * deliberate operator action; this file being present is not that action.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const LABEL = "[global-sync-rollout]";

/** Lanes enabled by a global cutover. Retention is deliberately absent. */
const CUTOVER_LANES = [
  "META_SYNC",
  "GOOGLE_SYNC",
  "SHOPIFY_SYNC",
  "SOURCE_INGEST",
  "CRON_ENQUEUE",
  "ASSIGNMENT_MUTATION",
] as const;

const ALL_LANES = [...CUTOVER_LANES, "RETENTION"] as const;

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Reported, but never a reason to abort. */
  advisory?: boolean;
}

function record(
  results: CheckResult[],
  name: string,
  ok: boolean,
  detail: string,
  advisory = false,
) {
  results.push({ name, ok, detail, advisory });
  const tag = ok ? "OK  " : advisory ? "NOTE" : "FAIL";
  console.log(`${LABEL} ${tag} ${name}: ${detail}`);
  return ok;
}

async function importDb() {
  const { getDb, resetDbClientCache } = await import("@/lib/db");
  resetDbClientCache();
  return getDb();
}

/** The five zero checks. Any non-zero means an old writer is still live. */
async function verifyQuiesced(results: CheckResult[]) {
  const sql = await importDb();
  const rows = (await sql.query(`
    SELECT
      (SELECT COUNT(*) FROM meta_sync_partitions WHERE lease_owner IS NOT NULL)::int AS meta_leases,
      (SELECT COUNT(*) FROM google_ads_sync_partitions WHERE lease_owner IS NOT NULL)::int AS google_leases,
      (SELECT COUNT(*) FROM sync_runner_leases WHERE lease_expires_at > now())::int AS runner_leases,
      (SELECT COUNT(*) FROM provider_sync_jobs WHERE status = 'running')::int AS running_jobs,
      (SELECT COUNT(*) FROM pg_stat_activity
        WHERE application_name LIKE 'omniads%' AND state <> 'idle'
          AND pid <> pg_backend_pid())::int AS active_backends
  `)) as Array<Record<string, number>>;
  const counts = rows[0] ?? {};
  let allZero = true;
  for (const [key, value] of Object.entries(counts)) {
    const zero = Number(value) === 0;
    allZero = record(results, `quiesced:${key}`, zero, String(value)) && allZero;
  }
  return allZero;
}

async function verifyFingerprints(results: CheckResult[]) {
  const sql = await importDb();
  const identity = (await sql.query(
    `SELECT current_database() AS datname, system_identifier::text AS system_identifier
     FROM pg_control_system()`,
  )) as Array<{ datname: string; system_identifier: string }>;
  record(
    results,
    "fingerprint:database_identity",
    identity.length === 1,
    `${identity[0]?.datname}:${identity[0]?.system_identifier}`,
  );

  const counts = (await sql.query(`
    SELECT
      (SELECT COUNT(*) FROM meta_raw_snapshots)::text AS meta_raw_snapshots,
      (SELECT COUNT(*) FROM shopify_raw_snapshots)::text AS shopify_raw_snapshots,
      (SELECT COUNT(*) FROM business_provider_accounts)::text AS bindings,
      (SELECT COUNT(*) FILTER (WHERE is_selected) FROM business_provider_accounts)::text AS selected
  `)) as Array<Record<string, string>>;
  record(
    results,
    "fingerprint:row_counts",
    true,
    JSON.stringify(counts[0] ?? {}),
  );

  // A binding set with nothing selected means the cutover deselected
  // everything — the single worst outcome of this change, and silent.
  const selected = Number(counts[0]?.selected ?? 0);
  const bindings = Number(counts[0]?.bindings ?? 0);
  return record(
    results,
    "fingerprint:selection_not_empty",
    bindings === 0 || selected > 0,
    `${selected}/${bindings} bindings selected`,
  );
}

async function verifyMigrationLanded(results: CheckResult[]) {
  const { verifyMigrationSchemaContract } = await import(
    "@/lib/migration-verification"
  );
  const verified = await verifyMigrationSchemaContract().then(
    (value) => ({ ok: true as const, detail: `${value.verified} objects verified` }),
    (error: unknown) => ({
      ok: false as const,
      detail: error instanceof Error ? error.message : String(error),
    }),
  );
  return record(results, "migration:schema_contract", verified.ok, verified.detail);
}

async function verifyReadiness(results: CheckResult[]) {
  const fence = await import("@/lib/sync/db-growth-fence");
  fence.resetDbGrowthFenceCache();
  const decision = await fence.evaluateDbGrowthFence();
  const admitted = record(
    results,
    "readiness:growth_fence",
    decision.allowed,
    `${decision.reason} warning=${decision.warning} database=${decision.databaseBytes}`,
  );
  // The warning is EXPECTED at the current size. Its absence means the budget
  // no longer describes this database, which is a reason to stop and re-derive
  // it — not to celebrate.
  // ADVISORY, not a gate. At production's current size the warning is expected
  // and its absence means the budget no longer describes this database — worth
  // saying out loud. But a database that has dropped BELOW the band is good
  // news, and refusing to enable because it got smaller would be absurd.
  record(
    results,
    "readiness:growth_fence_warning_present",
    decision.warning,
    decision.warning
      ? "warning band reached, as expected at the current production size"
      : "no warning — either this is not the production database, or it is smaller than the band; re-derive the budget if this is production",
    true,
  );

  // Physical headroom is decided from the database host's own telemetry, in the
  // same roundtrip as the logical sizes above. It is reported separately here
  // because "the fence admitted" and "the disk is fine" are different claims and
  // an operator needs to see both.
  const physical = decision.physical;
  record(
    results,
    "readiness:physical_capacity",
    physical?.admitted === true,
    physical
      ? `${physical.reason} path=${physical.dataPath} free=${String(physical.availableBytes)} projectedFree=${String(physical.projectedFreeBytes)} sampledAt=${String(physical.sampledAt)} ageSeconds=${String(physical.ageSeconds)} — ${physical.detail}`
      : "no physical decision was produced",
  );

  const retention = await import("@/lib/sync/retention-readiness");
  const readiness = await retention.getSyncRetentionExecutionReadiness();
  const retentionOk = record(
    results,
    "readiness:retention_contract",
    readiness.ready,
    readiness.ready
      ? "ready"
      : JSON.stringify({
          indexes: readiness.missingOrInvalidIndexes.slice(0, 5),
          columns: readiness.missingColumns.slice(0, 5),
        }),
  );
  return admitted && retentionOk && physical?.admitted === true;
}

async function verifyLanesCurrentlyOff(results: CheckResult[]) {
  const { describeSyncLaneAdmissions } = await import(
    "@/lib/sync/global-kill-switch"
  );
  const snapshot = describeSyncLaneAdmissions();
  return record(
    results,
    "switch:all_lanes_off",
    snapshot.allDisabled,
    snapshot.lanes.map((lane) => `${lane.lane}=${lane.enabled}`).join(" "),
  );
}

/** Exactly the keys this script owns. Nothing else in the file is its business. */
function managedKeys(): string[] {
  return [
    "ADSECUTE_SYNC_GLOBAL_ENABLED",
    ...ALL_LANES.map((lane) => `ADSECUTE_SYNC_LANE_${lane}_ENABLED`),
  ];
}

/**
 * Confirm the file being edited is the one the runtime actually sources.
 *
 * Writing lane switches into a file nothing reads is a silent no-op that looks
 * like a successful cutover — which is what a dedicated lane file would have
 * been here, since web, worker and migrate all source only the compose
 * project's env_file.
 */
function verifyComposeEnvSource(results: CheckResult[], targetPath: string) {
  const projectDir = path.dirname(targetPath);
  const composeCandidates = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ].map((name) => path.join(projectDir, name));
  const composePath = composeCandidates.find((candidate) => fs.existsSync(candidate));
  if (!composePath) {
    return record(
      results,
      "env:compose_source",
      false,
      `no compose file beside ${targetPath}; cannot confirm the runtime reads it`,
    );
  }
  const compose = fs.readFileSync(composePath, "utf8");
  const basename = path.basename(targetPath);
  const referenced =
    compose.includes(basename) || /env_file/.test(compose) === false;
  return record(
    results,
    "env:compose_source",
    compose.includes(basename),
    referenced
      ? `${composePath} references ${basename}`
      : `${composePath} does NOT reference ${basename}; writing there has no runtime effect`,
  );
}

/**
 * Update ONLY the managed keys, preserving every other byte.
 *
 * The earlier version of this rendered the whole file from the lane list. Aimed
 * at a dedicated file that was a harmless no-op; aimed at the real
 * `.env.production` it would have replaced DATABASE_URL, every credential and
 * every unrelated setting with six lines. Rewriting an env file wholesale is
 * never the right operation.
 *
 * A timestamped 0600 backup is taken first and its SHA-256 printed, so a
 * restore is possible and verifiable. Contents are never printed.
 *
 * ATOMICITY, precisely: temp-file-plus-rename makes the FILE change atomic. It
 * does NOT make the runtime change atomic — web and worker read their
 * environment when the container is created, so nothing takes effect until a
 * controlled recreate. Both processes must already be running the new build,
 * disabled, before this is used.
 */
function updateManagedKeysInPlace(input: {
  targetPath: string;
  enabledLanes: readonly string[];
}) {
  const desired = new Map<string, string>(
    managedKeys().map((key) => {
      if (key === "ADSECUTE_SYNC_GLOBAL_ENABLED") {
        return [key, input.enabledLanes.length > 0 ? "enabled" : ""];
      }
      const lane = key.replace("ADSECUTE_SYNC_LANE_", "").replace("_ENABLED", "");
      return [key, input.enabledLanes.includes(lane) ? "enabled" : ""];
    }),
  );

  const exists = fs.existsSync(input.targetPath);
  const original = exists ? fs.readFileSync(input.targetPath, "utf8") : "";
  const mode = exists ? fs.statSync(input.targetPath).mode & 0o777 : 0o600;

  if (exists) {
    const stamp = new Date(fs.statSync(input.targetPath).mtimeMs)
      .toISOString()
      .replace(/[:.]/g, "-");
    const backupPath = `${input.targetPath}.rollout-backup-${stamp}`;
    fs.writeFileSync(backupPath, original, { mode: 0o600 });
    const digest = createHash("sha256").update(original).digest("hex");
    console.log(`${LABEL} backup ${backupPath} sha256=${digest} bytes=${original.length}`);
  }

  const lines = original.length > 0 ? original.split("\n") : [];
  const seen = new Set<string>();
  const updated = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (!key || !desired.has(key)) return line;
    seen.add(key);
    return `${key}=${desired.get(key)}`;
  });
  const missing = managedKeys().filter((key) => !seen.has(key));
  if (missing.length > 0) {
    if (updated.length > 0 && updated[updated.length - 1] !== "") updated.push("");
    updated.push("# Managed by scripts/global-sync-rollout.ts — values only.");
    for (const key of missing) updated.push(`${key}=${desired.get(key)}`);
  }
  const next = updated.join("\n");

  const temp = `${input.targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, next, { mode });
  fs.renameSync(temp, input.targetPath);

  // Read back and prove BOTH directions: managed keys hold the intended value,
  // and every unrelated key survived byte-for-byte.
  const readback = fs.readFileSync(input.targetPath, "utf8");
  const parse = (text: string) => {
    const map = new Map<string, string>();
    for (const line of text.split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (match) map.set(match[1]!, match[2]!);
    }
    return map;
  };
  const before = parse(original);
  const after = parse(readback);
  for (const [key, value] of desired) {
    if (after.get(key) !== value) {
      throw new Error(
        `Readback mismatch: ${key} is '${String(after.get(key))}', expected '${value}'.`,
      );
    }
  }
  for (const [key, value] of before) {
    if (desired.has(key)) continue;
    if (after.get(key) !== value) {
      throw new Error(
        `Readback mismatch: unrelated key ${key} was modified or lost. Restore from the backup printed above.`,
      );
    }
  }
  console.log(
    `${LABEL} updated ${desired.size} managed keys; ${before.size - [...before.keys()].filter((key) => desired.has(key)).length} unrelated keys preserved.`,
  );
  console.log(
    `${LABEL} NOTE: this changed the FILE. Web and worker read their environment at container creation, so nothing takes effect until a controlled recreate.`,
  );
}

async function main() {
  const command = process.argv[2] ?? "preflight";
  // The compose project's env_file, because that is what web, worker and
  // migrate actually source. A dedicated lane file would be a silent no-op —
  // it looks like a successful cutover and changes nothing.
  const projectDir = process.env.SYNC_ROLLOUT_PROJECT_DIR ?? "/var/www/adsecute";
  const targetPath =
    process.env.SYNC_LANE_ENV_FILE ?? path.join(projectDir, ".env.production");

  if (command === "disable") {
    // Disabling has no DATABASE preconditions on purpose: stopping must always
    // be available, including when the database is unreachable. It still
    // confirms it is editing the file the runtime reads, because writing to the
    // wrong file would leave everything running while reporting success.
    const disableChecks: CheckResult[] = [];
    if (!verifyComposeEnvSource(disableChecks, targetPath)) {
      throw new Error(
        `Refusing to disable: ${targetPath} is not the env file the runtime sources.`,
      );
    }
    updateManagedKeysInPlace({ targetPath, enabledLanes: [] });
    console.log(`${LABEL} DISABLED every lane, including retention -> ${targetPath}`);
    console.log(`${LABEL} Restart the web and worker processes to load it.`);
    return;
  }

  if (command !== "preflight" && command !== "enable") {
    throw new Error(`Unknown command '${command}'. Use preflight | enable | disable.`);
  }

  const results: CheckResult[] = [];
  verifyComposeEnvSource(results, targetPath);
  await verifyLanesCurrentlyOff(results);
  await verifyQuiesced(results);
  await verifyFingerprints(results);
  await verifyMigrationLanded(results);
  await verifyReadiness(results);

  const failures = results.filter((result) => !result.ok && !result.advisory);
  console.log(
    `${LABEL} ${results.length - failures.length}/${results.length} checks passed.`,
  );

  if (command === "preflight") {
    console.log(
      `${LABEL} preflight only; nothing was changed. ${
        failures.length === 0 ? "Ready for enable." : "NOT ready."
      }`,
    );
    if (failures.length > 0) process.exitCode = 1;
    return;
  }

  if (failures.length > 0) {
    // No partial enable, no override.
    throw new Error(
      `Refusing to enable: ${failures.length} precondition(s) failed:\n` +
        failures.map((f) => `  - ${f.name}: ${f.detail}`).join("\n"),
    );
  }

  updateManagedKeysInPlace({ targetPath, enabledLanes: CUTOVER_LANES });
  console.log(
    `${LABEL} ENABLED ${CUTOVER_LANES.length} sync lanes atomically -> ${targetPath}`,
  );
  console.log(`${LABEL} retention remains DISABLED and is not enabled by this script.`);
  console.log(`${LABEL} Restart the web and worker processes to load it.`);
}

main().catch((error) => {
  console.error(`${LABEL} ABORTED`);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
