# Self-Hosted DB Ops

This project can run on a self-hosted PostgreSQL server without Neon.

For Meta sync queue pressure, drain-rate checks, and `pg_stat_activity` or `pg_stat_statements` workflows, use [`docs/meta-sync-hardening/postgres-runbook.md`](./meta-sync-hardening/postgres-runbook.md) first. This file stays focused on backups, health checks, and restore shape.

## Installed backup shape

- Daily logical backup of only irreplaceable tables
- Full schema-only dump
- Global roles dump
- 14-day retention
- Backup root: `/var/backups/adsecute-postgres`

The daily backup intentionally excludes warehouse, raw sync, and cache tables.
Those tables are rebuilt from provider sync jobs after a restore.

## Installed health checks

- PostgreSQL readiness on `127.0.0.1:5432`
- Latest backup age
- Root disk usage
- Current database size

## Admin capacity surface

Superadmins can inspect current capacity from `/admin/system-capacity`.

The page reads PostgreSQL size directly with `pg_database_size(current_database())`
and lists the largest application relations. DB-host disk usage is shown in its
own section from the latest `db_host_healthcheck` snapshot written by
`adsecute-db-healthcheck.sh`. Adsecute prod server disk usage is shown in a
separate section. Local development reads it over SSH from
`ADMIN_SYSTEM_CAPACITY_PROD_SSH_HOST`, falling back to the Adsecute prod SSH
host, while production reads live runtime `df -Pk` directly. Both paths use
`ADMIN_SYSTEM_CAPACITY_DISK_PATHS`, or `/` when unset. If no DB-host snapshot
exists yet, the DB-host section falls back to the runtime values and displays a
warning note.
Disk totals are filesystem-usable GiB values, so provider raw GB values can look
larger in Hetzner Cloud. Local macOS development can show APFS `df` values; that
is labeled as local runtime and is not the production server.

Optional environment overrides:

```bash
ADMIN_SYSTEM_CAPACITY_DISK_PATHS=/,/var/lib/postgresql
ADMIN_SYSTEM_CAPACITY_PROD_SSH_HOST=root@178.156.222.119
ADMIN_SYSTEM_CAPACITY_WARN_PCT=85
ADMIN_SYSTEM_CAPACITY_CRITICAL_PCT=95
```

After increasing the Hetzner volume size, grow the mounted ext4 filesystem on the
DB host as well:

```bash
resize2fs /dev/sdb
df -hT /var/lib/postgresql
```

## Commands

Run a backup now:

```bash
systemctl start adsecute-db-core-backup.service
```

Run a health check now:

```bash
systemctl start adsecute-db-healthcheck.service
journalctl -u adsecute-db-healthcheck.service -n 20 --no-pager
```

List timers:

```bash
systemctl list-timers --all | grep adsecute-db
```

Inspect latest backup:

```bash
ls -lah /var/backups/adsecute-postgres/latest
cat /var/backups/adsecute-postgres/latest/manifest.txt
(cd /var/backups/adsecute-postgres/latest && sha256sum -c SHA256SUMS)
```

## Large-table restore fingerprint

Use the bounded runner to prove that a UUID-keyed table and its isolated restore
have the same full-row multiset. It reads the heap in at most 65,536-block
(512 MiB at the production 8 KiB block size) CTID ranges and reduces every
range into 256 UUID first-byte buckets. CTIDs are only progress boundaries, so
the source and restore may have different physical layouts and block counts.
The runner uses `/usr/bin/python3` and the Python standard library already
installed on both production hosts; Node.js and Docker are not required.

The production `meta_entity_state_history` heap is about 36.29 GB, or 4.43
million blocks. The default therefore produces about 68 resumable chunks, not
256 table scans. Each database query has a zero-byte temp-file budget.

Prerequisites:

- All application, worker, cron, webhook, OAuth, and direct SQL writers for the
  target table are frozen.
- The output directory is on the app/backup volume, not the PostgreSQL volume.
- The latest `db_host_healthcheck` capacity snapshot is no more than 30 minutes
  old.
- The incident backup is already complete and independently checksummed.

Run from the off-volume host using normal libpq connection variables:

```bash
export PGHOST=db-host
export PGPORT=5432
export PGUSER=postgres
export DB_NAME=adsecute_prod

bash deploy/db/adsecute-table-fingerprint-runner.sh \
  --table meta_entity_state_history \
  --output-dir /var/backups/adsecute-incident/SOURCE/fingerprint-state-history \
  --writers-frozen "GLOBAL WRITERS FROZEN" \
  --off-volume-ack "OUTPUT IS OFF DB VOLUME"
```

The runner refuses stale/missing capacity data, target-table counter or
relfilenode drift, PostgreSQL restart/stat reset, DB free space below 20 GiB,
DB/root usage above 89%, output free space below 30 GiB, `pg_wal` above 4 GiB,
or WAL growth above 1 GiB. Threshold environment overrides can only make those
limits stricter.

Before the first chunk it runs a 32 MiB `EXPLAIN ANALYZE` preflight. Acceptance
requires `Tid Range Scan`, single-batch `HashAggregate`, no disk-backed sort or
hash, and no change in database temp counters. Every chunk also sets
`temp_file_limit=0`; a query that tries to spill fails before its part is
finalized. Because `pg_stat_database` counters include other sessions, a
concurrent temp-counter increase stops the runner before the next chunk but is
not attributed to this query. A successfully validated backend-clean part is
retained, so the stop does not force another 512 MiB read.

Completed `part-START-END.csv` files are immutable resume checkpoints. Re-run
the same command after resolving a stop condition; the runner validates and
skips complete parts. Failed or suspect partials are quarantined rather than
accepted. `manifest.tsv`, `preflight.plan`, and `progress.tsv` record the resume
contract and safety evidence.

Run the same process against the isolated restore in a different off-volume
directory, then compare the canonical results:

```bash
cmp -s \
  /var/backups/adsecute-incident/SOURCE/fingerprint-state-history/fingerprint.csv \
  /var/backups/adsecute-incident/RESTORE/fingerprint-state-history/fingerprint.csv
sha256sum \
  /var/backups/adsecute-incident/SOURCE/fingerprint-state-history/fingerprint.csv \
  /var/backups/adsecute-incident/RESTORE/fingerprint-state-history/fingerprint.csv
```

An exact `cmp` match is the acceptance result. A mismatch identifies one or
more UUID first-byte buckets for exact primary-key drilldown. Do not use a
fingerprint, row count, or successful decode alone as authorization to delete
production data.

## Restore outline

1. Recreate PostgreSQL and the target database.
2. Restore `globals.sql` if role state is needed.
3. Run app migrations.
4. Restore `core-data.dump` into the migrated database.
5. Restart the app and let provider sync refill warehouse tables.
