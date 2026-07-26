# Self-Hosted DB Ops

This project can run on a self-hosted PostgreSQL server without Neon.

For Meta sync queue pressure, drain-rate checks, and `pg_stat_activity` or `pg_stat_statements` workflows, use [`docs/meta-sync-hardening/postgres-runbook.md`](./meta-sync-hardening/postgres-runbook.md) first. This file stays focused on backups, health checks, and restore shape.

## Installed backup shape

`deploy/db/adsecute-db-core-backup.sh` takes **one complete custom-format
`pg_dump` of the whole database** — schema and data, every table, in pg_dump's
own consistent snapshot. There is no `--table`, no `--exclude-table`, and no list
of table names in the script.

- Backup root: `/var/backups/adsecute-postgres`
- 14-day retention, with a floor of 3 kept artifacts so a retention pass can
  never empty the root
- `umask 077`, atomic `mv` into `daily/<timestamp>/`, `latest` symlink

### Why it is a full dump

It used to dump a hand-written 15-table allowlist with `--data-only`. The schema
the application migrates creates **202 ordinary tables**, so 187 of them were
absent — including every table carrying Sync and integration authority and
continuity: `provider_connections`, `integration_credentials`,
`provider_accounts`, `business_provider_accounts`,
`provider_account_snapshot_runs`/`_items`, `shopify_install_contexts`,
`provider_sync_jobs`, `meta_*`/`google_ads_*` sync partitions, checkpoints and
runs, `sync_release_gates`, `sync_incidents`, `system_capacity_snapshots`,
`sessions`.

"Rebuilt from providers after a restore" was never true of those. After a restore
from the old artifact nobody was connected, no credential existed to reconnect
*with*, no account was selected, every connection generation reset to 1, and
every scheduling receipt and piece of release evidence was gone.

A longer allowlist is not the fix — a literal list silently omits whatever is
added next, which is how the 15-table list decayed. The script instead **proves**
completeness at backup time: it asks the live catalog for every ordinary table,
lists the dump's own table of contents with `pg_restore --list`, compares the two
sets, and **fails, naming the tables**, if anything is missing or unexpected.

### Files in each artifact

| File | What it is |
| --- | --- |
| `full-database.dump` | The artifact. Custom format, compress level 9, `--no-owner --no-privileges`. Restore with `pg_restore`. |
| `schema.sql` | Plain schema-only dump, for diffing during an incident without unpacking the archive. |
| `globals.sql` | `pg_dumpall --globals-only`. **Contains role password hashes** — this is why the whole directory is mode 0600. |
| `catalog-tables.txt` | Every ordinary table the live catalog held, one per line. |
| `dump-tables.txt` | Every table with a `TABLE DATA` entry in the dump. Must equal the above. |
| `dump-toc.txt` | Full `pg_restore --list` output. |
| `object-census.txt` | Counts of schemas, tables, views, sequences, indexes, functions, triggers, types, extensions and each constraint class. |
| `table-row-counts.tsv` | `table<TAB>rowcount` for every table. See `BACKUP_ROW_CENSUS` below. |
| `database_size_bytes.txt` | `pg_database_size()` at backup time. |
| `manifest.txt` | Everything above as `key=value`, plus versions, timings, sizes and SHA-256 digests. |
| `SHA256SUMS` | Relative-path checksums, so `sha256sum -c SHA256SUMS` works from inside the restored directory. |

Nothing the script prints or writes outside `full-database.dump` and
`globals.sql` contains a credential: only table names, counts, sizes and digests.

### Environment overrides

```bash
BACKUP_ROOT=/var/backups/adsecute-postgres
DB_NAME=adsecute_prod
RETENTION_DAYS=14
MIN_KEPT_BACKUPS=3
BACKUP_ROW_CENSUS=exact          # exact | estimate | off
BACKUP_DB_SUPERUSER=postgres
BACKUP_DB_HOST=                  # unset on the DB host: local unix socket
BACKUP_DB_PORT=
```

`BACKUP_ROW_CENSUS=exact` runs `COUNT(*)` on every table in one snapshot, which
costs roughly one extra full read of the database. That census is what a restore
is verified against; drop it to `estimate` (`pg_class.reltuples`, free) only if a
measurement on this host shows the exact pass is too slow, and understand that a
restore verified against an estimate proves less.

The script uses `runuser -u postgres --` only when `runuser` is present and it is
not already running as that user, so it also runs on hosts without util-linux
(macOS, CI). On the production DB host both conditions still hold and behaviour
is unchanged.

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

A whole-database dump takes materially longer than the old 15-table extract. If
`adsecute-db-core-backup.service` is ever given an explicit `TimeoutStartSec=`,
it must be large enough (or `infinity`) for a full dump; `Type=oneshot` units
have no start timeout by default, so the unit as shipped needs no change.
Measure the real duration on the host with:

```bash
systemd-analyze --no-pager | true
journalctl -u adsecute-db-core-backup.service -n 20 --no-pager
grep -E '^(dump_started_utc|dump_finished_utc|dump_bytes|database_size_bytes)=' \
  /var/backups/adsecute-postgres/latest/manifest.txt
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

## Restore procedure

This is the exact sequence proved end to end by
`scripts/ephemeral-postgres-dr-restore-seam.ts`, which takes a real backup with
this script and restores it into a second, empty PostgreSQL.

Restore into an **empty** database. Do **not** run migrations first: the dump
carries the schema, and `pg_restore` orders data before constraints, indexes and
triggers — several tables have insert-rejecting immutability triggers that would
refuse a data load into an already-migrated schema.

```bash
cd /var/backups/adsecute-postgres/latest

# 1. Integrity. Must pass before anything else.
sha256sum -c SHA256SUMS
cat manifest.txt

# 2. Roles, if role state is needed (skip on a host that already has them).
runuser -u postgres -- psql --dbname=postgres -v ON_ERROR_STOP=1 -f globals.sql

# 3. An EMPTY database.
runuser -u postgres -- createdb adsecute_prod

# 4. The restore. --exit-on-error is not optional: without it pg_restore
#    continues past failures and can exit 0 over a partial database.
runuser -u postgres -- pg_restore \
  --dbname=adsecute_prod \
  --no-owner --no-privileges \
  --exit-on-error \
  full-database.dump
```

### Verify the restore before pointing the app at it

```bash
# Row counts against the artifact's own census.
runuser -u postgres -- psql --dbname=adsecute_prod -At -F$'\t' -c "
  SELECT n.nspname||'.'||c.relname,
         (xpath('/row/c/text()', query_to_xml(
            format('SELECT COUNT(*) AS c FROM %I.%I', n.nspname, c.relname),
            false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p') AND c.relpersistence <> 't'
    AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
  ORDER BY 1" | diff - table-row-counts.tsv

# Authority spot checks. Non-zero, and generations preserved rather than reset.
runuser -u postgres -- psql --dbname=adsecute_prod -At -c "
  SELECT provider, status, connection_generation FROM provider_connections ORDER BY 1"
runuser -u postgres -- psql --dbname=adsecute_prod -At -c "
  SELECT count(*) FROM business_provider_accounts WHERE is_selected"
```

Then:

5. Run app migrations (`npm run migrate` / the deploy migration step). Against a
   faithful restore this is a convergence pass, not a rebuild.
6. Start the app.

Provider sync resumes from the restored partitions, checkpoints and scheduling
receipts rather than starting over.

### Known migration wrinkle seen during restore verification

`lib/migrations.ts` issues
`CREATE INDEX ... idx_google_ads_raw_snapshots_partition_endpoint` *before* the
`ALTER TABLE google_ads_raw_snapshots ADD COLUMN partition_id/page_index`
statements it depends on, and swallows the failure with `.catch(() => {})`. A
from-zero database is therefore missing that index until migrations run a second
time. This affects the original database exactly as much as a restored copy — it
is a migration-ordering defect, not a restore defect — but it is why the restore
seam asserts "the restored database converges on the same schema as the original"
rather than "migrations are a no-op".

## Proving the backup still works

```bash
npm run test:dr-restore-seam
```

Takes a real backup with `deploy/db/adsecute-db-core-backup.sh` against an
ephemeral migrated PostgreSQL holding linked authority state, restores it into a
second empty PostgreSQL, and proves: identical table set; exact row counts for
every table; every foreign key re-`VALIDATE`d by PostgreSQL against the restored
rows; byte-identical connection generations, credential digests, selection sets,
snapshot revisions, claim owners/epochs, connection fingerprints,
`scheduling_attempt_id` receipts, Shopify grants and release-gate evidence;
identical sequence positions; a real migration run that converges to the same
schema; and that no credential appears in anything the backup printed or wrote.
