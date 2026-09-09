import type { DbClient } from "@/lib/db";

const TiB = 1024 ** 4;

/**
 * Seed the host-produced evidence required by the physical growth fence.
 *
 * Real-PostgreSQL fixtures that exercise a fenced write must provide the same
 * canonical telemetry that production receives from db_host_healthcheck. The
 * generous capacity keeps logical business behavior as the subject of those
 * tests; the fence still parses and admits a real, fresh snapshot.
 */
export async function seedHealthyDbHostCapacitySnapshot(
  sql: DbClient,
  hostname: string,
) {
  await sql.query(
    `INSERT INTO system_capacity_snapshots (source, hostname, sampled_at, payload)
     VALUES ('db_host_healthcheck', $1, clock_timestamp(),
             jsonb_build_object(
               'hostname', $1::text,
               'database', jsonb_build_object('name', current_database()),
               'disks', jsonb_build_array(jsonb_build_object(
                 'path', '/var/lib/postgresql',
                 'totalBytes', $2::bigint,
                 'usedBytes', $3::bigint,
                 'availableBytes', $4::bigint
               ))
             ))`,
    [hostname, 8 * TiB, 1 * TiB, 7 * TiB],
  );
}
