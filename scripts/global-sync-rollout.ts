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
import path from "node:path";

const LABEL = "[global-sync-rollout]";

/** Lanes enabled by a global cutover. Retention is deliberately absent. */
const CUTOVER_LANES = [
  "META_SYNC",
  "GOOGLE_SYNC",
  "SHOPIFY_SYNC",
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

  const headroom = fence.evaluateVolumeHeadroom();
  record(
    results,
    "readiness:volume_headroom",
    headroom.status === "ok",
    `${headroom.status} available=${String(headroom.availableBytes)} (${headroom.note})`,
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
  return admitted && retentionOk && headroom.status === "ok";
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

/**
 * Write every lane in ONE file write.
 *
 * The failure this prevents is a partial enable: a sequence of manual exports
 * where the fourth fails leaves three lanes running against a deployment that
 * was never verified in that configuration. The file is rendered whole and
 * written via a temp file plus rename, so a crash mid-write leaves the previous
 * contents rather than half of the new ones.
 */
function writeLaneFileAtomically(input: {
  targetPath: string;
  enabledLanes: readonly string[];
}) {
  const lines = [
    "# Written by scripts/global-sync-rollout.ts. Do not hand-edit during a rollout.",
    `# Generated for lanes: ${input.enabledLanes.join(", ") || "(none)"}`,
    `ADSECUTE_SYNC_GLOBAL_ENABLED=${input.enabledLanes.length > 0 ? "enabled" : ""}`,
    ...ALL_LANES.map(
      (lane) =>
        `ADSECUTE_SYNC_LANE_${lane}_ENABLED=${
          input.enabledLanes.includes(lane) ? "enabled" : ""
        }`,
    ),
    "",
  ];
  const temp = `${input.targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, lines.join("\n"), { mode: 0o600 });
  fs.renameSync(temp, input.targetPath);
}

async function main() {
  const command = process.argv[2] ?? "preflight";
  const targetPath =
    process.env.SYNC_LANE_ENV_FILE ??
    path.join(process.cwd(), ".env.sync-lanes");

  if (command === "disable") {
    // Disabling has no preconditions on purpose: stopping must always be
    // available, including when the database is unreachable.
    writeLaneFileAtomically({ targetPath, enabledLanes: [] });
    console.log(`${LABEL} DISABLED every lane, including retention -> ${targetPath}`);
    console.log(`${LABEL} Restart the web and worker processes to load it.`);
    return;
  }

  if (command !== "preflight" && command !== "enable") {
    throw new Error(`Unknown command '${command}'. Use preflight | enable | disable.`);
  }

  const results: CheckResult[] = [];
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

  writeLaneFileAtomically({ targetPath, enabledLanes: CUTOVER_LANES });
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
