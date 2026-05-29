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
cat /var/backups/adsecute-postgres/latest/SHA256SUMS
```

## Restore outline

1. Recreate PostgreSQL and the target database.
2. Restore `globals.sql` if role state is needed.
3. Run app migrations.
4. Restore `core-data.dump` into the migrated database.
5. Restart the app and let provider sync refill warehouse tables.
