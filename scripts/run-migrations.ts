import { loadEnvConfig } from "@next/env";
import { getDbWithTimeout, resetDbClientCache } from "@/lib/db";
import { runMigrations } from "@/lib/migrations";

loadEnvConfig(process.cwd());

const DEFAULT_DEPLOY_MIGRATION_TIMEOUT_MS = 30 * 60_000;

function getDeployMigrationTimeoutMs() {
  const raw =
    process.env.DEPLOY_MIGRATION_TIMEOUT_MS?.trim() ||
    process.env.MIGRATION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_DEPLOY_MIGRATION_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEPLOY_MIGRATION_TIMEOUT_MS;
}

async function main() {
  const timeoutMs = getDeployMigrationTimeoutMs();
  await runMigrations({
    force: true,
    reason: "deploy",
    timeoutMs,
  });
  const sql = getDbWithTimeout(timeoutMs);
  const [verification] = (await sql`
    SELECT json_build_object(
      'metaSyncPartitionsLeaseEpochExists',
      EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_class class ON class.oid = attribute.attrelid
        WHERE class.oid = 'meta_sync_partitions'::regclass
          AND attribute.attname = 'lease_epoch'
          AND NOT attribute.attisdropped
      ),
      'metaSyncCheckpointsLeaseEpochExists',
      EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_class class ON class.oid = attribute.attrelid
        WHERE class.oid = 'meta_sync_checkpoints'::regclass
          AND attribute.attname = 'lease_epoch'
          AND NOT attribute.attisdropped
      ),
      'metaSyncPartitionsLeaseEpochNullCount',
      (
        SELECT COUNT(*)::int
        FROM meta_sync_partitions
        WHERE lease_epoch IS NULL
      ),
      'metaSyncCheckpointsLeaseEpochNullRowsPresent',
      (
        SELECT EXISTS (
          SELECT 1
          FROM meta_sync_checkpoints
          WHERE lease_epoch IS NULL
          LIMIT 1
        )
      ),
      'syncIncidentsExists',
      to_regclass('public.sync_incidents') IS NOT NULL
    ) AS summary
  `) as Array<{ summary: unknown }>;

  const summary =
    verification?.summary && typeof verification.summary === "object"
      ? (verification.summary as {
          metaSyncPartitionsLeaseEpochExists?: boolean;
          metaSyncCheckpointsLeaseEpochExists?: boolean;
          metaSyncPartitionsLeaseEpochNullCount?: number;
          metaSyncCheckpointsLeaseEpochNullRowsPresent?: boolean;
          syncIncidentsExists?: boolean;
        })
      : null;

  if (!summary?.syncIncidentsExists) {
    throw new Error("Migration verification failed: sync_incidents table is missing after deploy migration.");
  }

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .then(() => {
    resetDbClientCache();
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    resetDbClientCache();
    process.exit(1);
  });
