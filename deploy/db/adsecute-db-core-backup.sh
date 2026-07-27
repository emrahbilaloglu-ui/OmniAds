#!/usr/bin/env bash
set -euo pipefail

umask 077

# ─────────────────────────────────────────────────────────────────────────────
# Daily DISASTER-RECOVERY backup.
#
# This script used to dump a hand-written 15-table allowlist with --data-only,
# under the theory that everything else "is rebuilt from providers after a
# restore". The schema this application migrates creates 202 ordinary tables, so
# 187 of them were absent from the artifact — including every table that carries
# Sync and integration AUTHORITY and CONTINUITY:
#
#   provider_connections, integration_credentials, business_provider_accounts,
#   provider_accounts, provider_account_snapshot_runs/_items,
#   shopify_install_contexts, provider_sync_jobs, meta_/google_ads_sync_*,
#   sync_release_gates, sync_incidents, system_capacity_snapshots, sessions …
#
# "Rebuilt from providers" is not true of any of those. After a restore from the
# old artifact nobody was connected, no credential existed to reconnect WITH, no
# account was selected, every connection generation reset, every scheduling
# receipt and every piece of release evidence was gone. That is not a recovered
# system; it is a fresh install with some business rows in it.
#
# The fix is not a longer allowlist. A literal list of table names silently omits
# whatever is added next — which is exactly how the 15-table list decayed. So:
#
#   * the artifact is ONE complete custom-format pg_dump of the WHOLE database,
#     schema and data, taken in pg_dump's own consistent snapshot;
#   * there is no --table, no --exclude-table, and no list of table names
#     anywhere in this file;
#   * the script then PROVES completeness by comparing the dump's own table-of-
#     contents against the live catalog, and fails loudly, naming the tables, if
#     anything the catalog knows about is missing from the artifact.
#
# Nothing here ever selects, prints or logs a column value. Everything reported
# is a table name, a count, a byte size or a digest.
# ─────────────────────────────────────────────────────────────────────────────

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/adsecute-postgres}"
DB_NAME="${DB_NAME:-adsecute_prod}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
# A retention pass must never be able to empty the backup root. Without a floor,
# a run of failed backups plus one retention pass leaves zero artifacts.
MIN_KEPT_BACKUPS="${MIN_KEPT_BACKUPS:-3}"
# exact   — COUNT(*) per table, one snapshot. The census a restore is verified
#           against. Costs roughly one extra full read of the database.
# estimate — pg_class.reltuples. Free, and only an estimate; a restore verified
#           against it proves less.
# off     — no census file at all.
BACKUP_ROW_CENSUS="${BACKUP_ROW_CENSUS:-exact}"
BACKUP_DB_SUPERUSER="${BACKUP_DB_SUPERUSER:-postgres}"
# Unset by default, which keeps the production path byte-identical to before:
# a local unix-socket connection as the postgres role. Set only by the
# disaster-recovery seam, which targets an ephemeral server over TCP.
BACKUP_DB_HOST="${BACKUP_DB_HOST:-}"
BACKUP_DB_PORT="${BACKUP_DB_PORT:-}"
# Where tier-B per-table archives are written. MUST be on a different filesystem
# from the PostgreSQL data directory: a backup that shares a disk with the data
# it protects is not a backup. Verified below, not assumed.
BACKUP_ARCHIVE_ROOT="${BACKUP_ARCHIVE_ROOT:-$BACKUP_ROOT/archive}"
RECOVERY_POLICY_FILE="${RECOVERY_POLICY_FILE:-$(dirname "$0")/recovery-policy.tsv}"
# Tables whose DATA must always be in the primary artifact. A policy line moving
# any of these to tier B is refused. This list is about AUTHORITY and CONTINUITY:
# who is connected, with what credential, what is selected, what was scheduled,
# and what evidence a release was gated on.
RECOVERY_AUTHORITY_TABLES="\
users businesses memberships invites sessions \
provider_connections provider_accounts integration_credentials \
business_provider_accounts provider_account_assignments \
provider_account_snapshot_runs provider_account_snapshot_items \
shopify_install_contexts shopify_subscriptions \
provider_sync_jobs meta_sync_jobs google_ads_sync_jobs \
meta_sync_partitions google_ads_sync_partitions \
meta_sync_runs google_ads_sync_runs \
meta_sync_checkpoints google_ads_sync_checkpoints \
sync_release_gates sync_incidents sync_repair_plans \
sync_runner_leases sync_worker_heartbeats system_capacity_snapshots \
schema_legacy_import_state"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET_DIR="$BACKUP_ROOT/daily/$TIMESTAMP"
TMP_DIR="$BACKUP_ROOT/.tmp-$TIMESTAMP"

fail() {
  echo "backup_failed reason=$1" >&2
  exit 1
}

cleanup() {
  rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Run a PostgreSQL client program as the database superuser.
#
# `runuser` is a util-linux program: it exists on the Debian DB host this runs on
# and does not exist on macOS, so the previous unconditional `runuser -u postgres
# --` prefix made this script impossible to execute anywhere else — including in
# the disaster-recovery seam that now proves it works. It is used when it is
# present AND we are not already running as the target user; otherwise the client
# runs directly. On the production host both conditions still hold (the timer
# runs as root, runuser is installed), so production behaviour is unchanged, and
# a host where runuser vanished fails loudly on authentication rather than
# silently backing up as the wrong role.
as_postgres() {
  # `runuser` is used only when it can actually work: it exists, we are root,
  # and we are not already the target user.
  #
  # Checking existence alone was wrong. On a CI runner `runuser` is installed
  # but the job runs as an unprivileged user, so it exists, is selected, and
  # then fails with "may not be used by non-root users" — which is how a backup
  # script that works on the production host fails everywhere else.
  if [ "$(id -un)" = "$BACKUP_DB_SUPERUSER" ] \
    || [ "$(id -u)" != "0" ] \
    || ! command -v runuser >/dev/null 2>&1; then
    "$@"
  else
    runuser -u "$BACKUP_DB_SUPERUSER" -- "$@"
  fi
}

# bash 3.2 (macOS) errors on "${arr[@]}" for an empty array under `set -u`, so
# every expansion of this array uses the guarded form below.
conn_args=()
if [ -n "$BACKUP_DB_HOST" ]; then conn_args+=( "--host=$BACKUP_DB_HOST" ); fi
if [ -n "$BACKUP_DB_PORT" ]; then conn_args+=( "--port=$BACKUP_DB_PORT" ); fi

if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$@"; }
else
  fail "no_sha256_tool"
fi

psql_value() {
  as_postgres psql ${conn_args[@]+"${conn_args[@]}"} \
    --dbname="$1" \
    -v ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --command="$2"
}

mkdir -p "$BACKUP_ROOT/daily"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

# ── 0. Recovery policy ───────────────────────────────────────────────────────
#
# DEFAULT IS TIER A: a table absent from the policy file gets its data into the
# primary artifact. Forgetting to classify a new table costs disk, never data.
tier_b_tables=""
if [ -f "$RECOVERY_POLICY_FILE" ]; then
  tier_b_tables="$(awk -F'\t' '
    /^[[:space:]]*#/ { next }
    NF >= 2 && $2 == "B" { print $1 }
  ' "$RECOVERY_POLICY_FILE" | LC_ALL=C sort -u)"
else
  echo "recovery_policy_missing path=$RECOVERY_POLICY_FILE" >&2
  fail "recovery_policy_missing"
fi

# An authority table may never be tier B.
for t in $RECOVERY_AUTHORITY_TABLES; do
  if printf '%s\n' "$tier_b_tables" | grep -qx "$t"; then
    echo "recovery_policy_violation authority_table_in_tier_b=$t" >&2
    fail "authority_table_in_tier_b"
  fi
done

# Every tier-B table must actually exist; a stale policy line hides a typo that
# would otherwise silently put a real table's data nowhere.
for t in $tier_b_tables; do
  present="$(psql_value "$DB_NAME" "SELECT to_regclass('public.${t}') IS NOT NULL")"
  if [ "$present" != "t" ]; then
    echo "recovery_policy_violation tier_b_table_absent=$t" >&2
    fail "tier_b_table_absent_from_catalog"
  fi

  # A tier-B table may not be the PARENT of a foreign key.
  #
  # pg_restore loads data first and adds constraints afterwards. If a tier-A
  # child row references a tier-B parent whose rows are in a separate archive,
  # ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY fails validation and the
  # artifact does not restore at all — so the backup looks successful and the
  # rollback does not exist. Found exactly this way: a production scratch
  # restore died on meta_account_daily_source_snapshot_id_fkey because
  # meta_raw_snapshots (8 inbound FKs) had been classified tier B.
  inbound="$(psql_value "$DB_NAME" "
    SELECT count(*)::text FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'public' AND c.relname = '${t}'")"
  if [ "${inbound:-0}" != "0" ]; then
    echo "recovery_policy_violation tier_b_table_has_inbound_fks=$t count=$inbound" >&2
    fail "tier_b_table_is_a_foreign_key_parent"
  fi
done

tier_b_count="$(printf '%s\n' "$tier_b_tables" | grep -c . || true)"
exclude_args=()
for t in $tier_b_tables; do
  exclude_args+=( "--exclude-table-data=public.${t}" )
done

# ── 1. The artifact ──────────────────────────────────────────────────────────
#
# One pg_dump, whole database, custom format. No table filter of any kind: the
# only way an object can be missing from this dump is if pg_dump itself omits it,
# and step 2 detects that.
#
# Redirected rather than --file= on purpose: TMP_DIR is created by this script
# (root, mode 0700 under umask 077) and the dump program may be running as the
# postgres user, which cannot create files inside it.
dump_started_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
as_postgres pg_dump ${conn_args[@]+"${conn_args[@]}"} \
  --dbname="$DB_NAME" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --no-tablespaces \
  ${exclude_args[@]+"${exclude_args[@]}"} \
  > "$TMP_DIR/full-database.dump"
dump_finished_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Kept because it is small, human-readable and diffable, and because a schema
# question during an incident should not require unpacking the archive.
as_postgres pg_dump ${conn_args[@]+"${conn_args[@]}"} \
  --dbname="$DB_NAME" \
  --format=plain \
  --schema-only \
  --no-owner \
  --no-privileges > "$TMP_DIR/schema.sql"

# Roles and role memberships. NOTE: on a superuser connection this file contains
# role password hashes, which is why the whole artifact is written under
# `umask 077`. It is never read back or echoed by this script.
as_postgres pg_dumpall ${conn_args[@]+"${conn_args[@]}"} --globals-only > "$TMP_DIR/globals.sql"

# ── 2. Completeness, derived from the live catalog ───────────────────────────
#
# Every ordinary table PostgreSQL currently knows about, asked of the catalog at
# runtime. Partitioned parents (relkind 'p') hold no rows of their own and get no
# TABLE DATA entry; extension-owned tables are dumped by the extension, not by
# pg_dump. Both are excluded from the EXPECTATION, not from the dump.
psql_value "$DB_NAME" "
  SELECT n.nspname || '.' || c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND c.relpersistence <> 't'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname !~ '^pg_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
    )
  ORDER BY 1
" | LC_ALL=C sort > "$TMP_DIR/catalog-tables.txt"

pg_restore --list "$TMP_DIR/full-database.dump" > "$TMP_DIR/dump-toc.txt"
awk '$1 ~ /^[0-9]+;$/ && $4 == "TABLE" && $5 == "DATA" { print $6 "." $7 }' \
  "$TMP_DIR/dump-toc.txt" | LC_ALL=C sort > "$TMP_DIR/dump-tables.txt"

# Tier-B tables are deliberately absent from TABLE DATA. They must still be in
# the artifact's SCHEMA, or a tier-A restore would not even have somewhere to
# replay the archive into — so that is checked explicitly rather than assumed.
printf '%s\n' "$tier_b_tables" | grep . | sed 's/^/public./' | LC_ALL=C sort \
  > "$TMP_DIR/tier-b-tables.txt" || : > "$TMP_DIR/tier-b-tables.txt"
LC_ALL=C comm -23 "$TMP_DIR/catalog-tables.txt" "$TMP_DIR/tier-b-tables.txt" \
  > "$TMP_DIR/expected-data-tables.txt"

for t in $tier_b_tables; do
  # A plain TABLE entry is "<id>; <oid> <oid> TABLE <schema> <name> <owner>",
  # whereas TABLE DATA shifts every field right by one. Matching the DATA layout
  # against a TABLE line silently never matches.
  if ! awk -v want="$t" '$1 ~ /^[0-9]+;$/ && $4 == "TABLE" && $5 == "public" && $6 == want { found = 1 }
       END { exit found ? 0 : 1 }' "$TMP_DIR/dump-toc.txt"; then
    echo "backup_incomplete tier_b_schema_missing=$t" >&2
    fail "tier_b_table_schema_missing_from_dump"
  fi
done

missing_from_dump="$(LC_ALL=C comm -23 "$TMP_DIR/expected-data-tables.txt" "$TMP_DIR/dump-tables.txt")"
unexpected_in_dump="$(LC_ALL=C comm -13 "$TMP_DIR/expected-data-tables.txt" "$TMP_DIR/dump-tables.txt")"

if [ -n "$missing_from_dump" ]; then
  echo "backup_incomplete missing_tables=$(echo "$missing_from_dump" | tr '\n' ',' | sed 's/,$//')" >&2
  fail "tables_missing_from_dump"
fi
if [ -n "$unexpected_in_dump" ]; then
  echo "backup_unexpected extra_tables=$(echo "$unexpected_in_dump" | tr '\n' ',' | sed 's/,$//')" >&2
  fail "unexpected_tables_in_dump"
fi

catalog_tables="$(wc -l < "$TMP_DIR/catalog-tables.txt" | tr -d ' ')"
dump_table_data_entries="$(wc -l < "$TMP_DIR/dump-tables.txt" | tr -d ' ')"
dump_sequence_set_entries="$(awk '$1 ~ /^[0-9]+;$/ && $4 == "SEQUENCE" && $5 == "SET"' \
  "$TMP_DIR/dump-toc.txt" | wc -l | tr -d ' ')"

# ── 2b. Tier-B archives ──────────────────────────────────────────────────────
#
# One data-only custom-format archive per tier-B table, written to a filesystem
# that is NOT the one holding the data. Each is validated on the two facts a
# replay depends on: the row count PostgreSQL reports, and the digest of the
# bytes actually written. A mismatch fails the whole backup — a tier-B archive
# that silently truncated would leave a restore quietly short of 22 million rows.
#
# These tables are NOT discarded and NOT considered rebuildable. Every one was
# classified independently and none has a regeneration path: they are
# point-in-time observations the provider will not re-serve. The split exists
# only because the migration provably does not mutate them, so a ROLLBACK does
# not need them — a DISASTER RECOVERY still does, which is why they are archived
# rather than skipped.
archive_dir="$BACKUP_ARCHIVE_ROOT/$TIMESTAMP"
mkdir -p "$archive_dir"
chmod 0700 "$archive_dir" 2>/dev/null || true

# A backup on the same filesystem as the data it protects is not a backup.
data_dir_fs="$(psql_value "$DB_NAME" "SHOW data_directory" 2>/dev/null || echo "")"
if [ -n "$data_dir_fs" ] && [ -d "$data_dir_fs" ]; then
  # Device id, portably. `stat -c` is GNU and `stat -f` is BSD; reading one and
  # falling back to a literal made both sides differ on macOS, so the guard
  # silently never fired — which is worse than not having it.
  device_of() {
    stat -c %d "$1" 2>/dev/null || stat -f %d "$1" 2>/dev/null || printf 'unknown'
  }
  data_device="$(device_of "$data_dir_fs")"
  archive_device="$(device_of "$archive_dir")"
  if [ "$data_device" = "unknown" ] || [ "$archive_device" = "unknown" ]; then
    echo "backup_archive_device_unreadable data_dir=$data_dir_fs archive=$archive_dir" >&2
    fail "cannot_determine_archive_filesystem"
  fi
  if [ "$data_device" = "$archive_device" ]; then
    # A single-filesystem environment is real for a test harness — an ephemeral
    # PostgreSQL and its throwaway archive live in the same temp dir — and never
    # acceptable in production. The escape is therefore explicit, named for
    # exactly what it gives up, and it announces itself in the log so an
    # artifact produced under it is never mistaken for a real one.
    if [ "${BACKUP_ARCHIVE_ALLOW_SAME_FILESYSTEM:-}" = "1" ]; then
      echo "backup_archive_colocation_ALLOWED_for_test data_dir=$data_dir_fs archive=$archive_dir" >&2
    else
      echo "backup_archive_colocated_with_data data_dir=$data_dir_fs archive=$archive_dir" >&2
      fail "archive_shares_filesystem_with_data"
    fi
  fi
fi

: > "$TMP_DIR/tier-b-manifest.tsv"
tier_b_bytes_total=0
tier_b_rows_total=0
for t in $tier_b_tables; do
  rows="$(psql_value "$DB_NAME" "SELECT count(*) FROM public.${t}")"
  out="$archive_dir/${t}.dump"
  as_postgres pg_dump ${conn_args[@]+"${conn_args[@]}"} \
    --dbname="$DB_NAME" \
    --format=custom \
    --compress=9 \
    --data-only \
    --no-owner \
    --no-privileges \
    --no-tablespaces \
    --table="public.${t}" > "$out"

  bytes="$(wc -c < "$out" | tr -d ' ')"
  digest="$(checksum "$out" | awk '{print $1}')"
  # The archive must contain a TABLE DATA entry for exactly this table.
  entries="$(pg_restore --list "$out" \
    | awk -v want="$t" '$1 ~ /^[0-9]+;$/ && $4 == "TABLE" && $5 == "DATA" && $7 == want' \
    | wc -l | tr -d ' ')"
  if [ "$entries" != "1" ]; then
    echo "backup_archive_invalid table=$t table_data_entries=$entries" >&2
    fail "tier_b_archive_missing_table_data"
  fi
  if [ "$bytes" -le 0 ]; then
    echo "backup_archive_empty table=$t" >&2
    fail "tier_b_archive_empty"
  fi
  printf '%s\t%s\t%s\t%s\n' "$t" "$rows" "$bytes" "$digest" >> "$TMP_DIR/tier-b-manifest.tsv"
  tier_b_bytes_total=$(( tier_b_bytes_total + bytes ))
  tier_b_rows_total=$(( tier_b_rows_total + rows ))
done
( cd "$archive_dir" && checksum ./*.dump > SHA256SUMS 2>/dev/null ) || true
cp "$TMP_DIR/tier-b-manifest.tsv" "$archive_dir/tier-b-manifest.tsv" 2>/dev/null || true

# ── 3. What the artifact contains, so a restorer can check it ────────────────
psql_value "$DB_NAME" "
  SELECT line FROM (VALUES
    (1, 'object_schemas=' || (SELECT count(*) FROM pg_namespace
          WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_')),
    (2, 'object_tables=' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_')),
    (3, 'object_views=' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.relkind IN ('v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_')),
    (4, 'object_sequences=' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_')),
    (5, 'object_indexes=' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.relkind='i' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_')),
    (6, 'object_functions=' || (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
            AND NOT EXISTS (SELECT 1 FROM pg_depend d
              WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'))),
    (7, 'object_triggers=' || (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_')),
    (8, 'object_types=' || (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE t.typtype IN ('e','d') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_')),
    (9, 'object_extensions=' || (SELECT count(*) FROM pg_extension)),
    (10, 'constraint_primary_key=' || (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace
          WHERE k.contype='p' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_')),
    (11, 'constraint_foreign_key=' || (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace
          WHERE k.contype='f' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_')),
    (12, 'constraint_unique=' || (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace
          WHERE k.contype='u' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_')),
    (13, 'constraint_check=' || (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace
          WHERE k.contype='c' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_')),
    (14, 'constraint_trigger=' || (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace
          WHERE k.contype='t' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'))
  ) AS t(ord, line) ORDER BY ord
" > "$TMP_DIR/object-census.txt"

# ── 4. Row census ────────────────────────────────────────────────────────────
#
# Taken AFTER the dump and in its own snapshot, so on a live database a table
# written to during the dump can legitimately differ by the writes in between.
# The completeness proof above does not depend on it; it is the artifact's
# "how much was in here" record and the thing a restore is compared against.
row_census_taken_utc=""
row_census_total_rows=""
case "$BACKUP_ROW_CENSUS" in
  exact)
    row_census_taken_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    psql_value "$DB_NAME" "
      SELECT n.nspname || '.' || c.relname || E'\t' ||
             (xpath('/row/c/text()',
                    query_to_xml(format('SELECT COUNT(*) AS c FROM %I.%I', n.nspname, c.relname),
                                 false, true, '')))[1]::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p')
        AND c.relpersistence <> 't'
        AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname !~ '^pg_'
      ORDER BY 1
    " > "$TMP_DIR/table-row-counts.tsv"
    row_census_total_rows="$(awk -F'\t' '{ total += $2 } END { print total + 0 }' "$TMP_DIR/table-row-counts.tsv")"
    ;;
  estimate)
    row_census_taken_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    psql_value "$DB_NAME" "
      SELECT n.nspname || '.' || c.relname || E'\t' || c.reltuples::bigint::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p')
        AND c.relpersistence <> 't'
        AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname !~ '^pg_'
      ORDER BY 1
    " > "$TMP_DIR/table-row-counts.tsv"
    row_census_total_rows="$(awk -F'\t' '{ total += $2 } END { print total + 0 }' "$TMP_DIR/table-row-counts.tsv")"
    ;;
  off) : ;;
  *) fail "unknown_row_census_mode" ;;
esac

# ── 5. Manifest ──────────────────────────────────────────────────────────────
database_size_bytes="$(psql_value postgres "SELECT pg_database_size('$DB_NAME');" | tr -d '\n')"
echo "$database_size_bytes" > "$TMP_DIR/database_size_bytes.txt"
server_version="$(psql_value "$DB_NAME" "SHOW server_version;" | tr -d '\n')"
pg_dump_version="$(pg_dump --version | tr -d '\n')"
dump_bytes="$(wc -c < "$TMP_DIR/full-database.dump" | tr -d ' ')"
dump_sha256="$(checksum "$TMP_DIR/full-database.dump" | awk '{print $1}')"
schema_sha256="$(checksum "$TMP_DIR/schema.sql" | awk '{print $1}')"
globals_sha256="$(checksum "$TMP_DIR/globals.sql" | awk '{print $1}')"
row_census_sha256=""
if [ -f "$TMP_DIR/table-row-counts.tsv" ]; then
  row_census_sha256="$(checksum "$TMP_DIR/table-row-counts.tsv" | awk '{print $1}')"
fi

{
  echo "manifest_version=2"
  echo "timestamp_utc=$TIMESTAMP"
  echo "database=$DB_NAME"
  echo "backup_scope=full_database"
  echo "backup_method=pg_dump --format=custom, whole database, no table filter"
  echo "table_filter=none"
  echo "retention_days=$RETENTION_DAYS"
  echo "min_kept_backups=$MIN_KEPT_BACKUPS"
  echo "server_version=$server_version"
  echo "pg_dump_version=$pg_dump_version"
  echo "dump_started_utc=$dump_started_utc"
  echo "dump_finished_utc=$dump_finished_utc"
  echo "database_size_bytes=$database_size_bytes"
  echo "dump_bytes=$dump_bytes"
  echo "dump_sha256=$dump_sha256"
  echo "schema_sql_sha256=$schema_sha256"
  echo "globals_sql_sha256=$globals_sha256"
  echo "catalog_tables=$catalog_tables"
  echo "dump_table_data_entries=$dump_table_data_entries"
  echo "dump_sequence_set_entries=$dump_sequence_set_entries"
  echo "missing_from_dump=0"
  echo "unexpected_in_dump=0"
  cat "$TMP_DIR/object-census.txt"
  echo "row_census_mode=$BACKUP_ROW_CENSUS"
  echo "row_census_taken_utc=$row_census_taken_utc"
  echo "row_census_total_rows=$row_census_total_rows"
  echo "row_census_sha256=$row_census_sha256"
  echo "globals_sql_contains_role_secrets=true"
  echo "restore_command=pg_restore --dbname=<new_db> --no-owner --no-privileges --exit-on-error full-database.dump"
  echo "recovery_tiers=A_primary_plus_B_archives"
  echo "tier_b_table_count=${tier_b_count}"
  echo "tier_b_tables=$(printf '%s' "$tier_b_tables" | tr '\n' ',' | sed 's/,$//')"
  echo "tier_b_rows_total=${tier_b_rows_total}"
  echo "tier_b_bytes_total=${tier_b_bytes_total}"
  echo "tier_b_archive_dir=${archive_dir}"
  echo "tier_b_manifest=tier-b-manifest.tsv"
  echo "restore_order=1) pg_restore full-database.dump  2) replay each tier-B archive with pg_restore --data-only"
  echo "verify_command=sha256sum -c SHA256SUMS"
} > "$TMP_DIR/manifest.txt"

# Relative names, computed from inside the directory, so `sha256sum -c
# SHA256SUMS` works from the restored artifact. The previous version recorded
# absolute paths under a .tmp- directory that the atomic `mv` immediately
# renamed away, which made the checksum file unverifiable by construction.
(
  cd "$TMP_DIR"
  census_file=""
  if [ -f table-row-counts.tsv ]; then census_file="table-row-counts.tsv"; fi
  checksum full-database.dump schema.sql globals.sql catalog-tables.txt dump-tables.txt \
    dump-toc.txt object-census.txt database_size_bytes.txt ${census_file:+$census_file} manifest.txt \
    > SHA256SUMS
)

mv "$TMP_DIR" "$TARGET_DIR"
ln -sfn "$TARGET_DIR" "$BACKUP_ROOT/latest"

# ── 6. Retention, with a floor ───────────────────────────────────────────────
keep_list="$(mktemp)"
find "$BACKUP_ROOT/daily" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort \
  | tail -n "$MIN_KEPT_BACKUPS" > "$keep_list"
find "$BACKUP_ROOT/daily" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" \
  | LC_ALL=C sort \
  | { grep -vxF -f "$keep_list" || true; } \
  | while IFS= read -r stale; do
      if [ -n "$stale" ]; then rm -rf "$stale"; fi
    done
rm -f "$keep_list"

echo "backup_ok path=$TARGET_DIR scope=full_database tables=$catalog_tables dump_bytes=$dump_bytes row_census=$BACKUP_ROW_CENSUS rows=$row_census_total_rows"
