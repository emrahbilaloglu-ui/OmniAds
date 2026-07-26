#!/usr/bin/env bash
set -euo pipefail

umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHUNK_SQL="$SCRIPT_DIR/adsecute-table-fingerprint-chunk.sql"
REDUCER="$SCRIPT_DIR/adsecute-table-fingerprint-reduce.py"

PSQL_BIN="${PSQL_BIN:-psql}"
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"
DB_NAME="${DB_NAME:-adsecute_prod}"
TABLE_NAME="meta_entity_state_history"
OUTPUT_DIR=""
WRITERS_FROZEN_ACK=""
OFF_VOLUME_ACK=""
CHUNK_BLOCKS="${FINGERPRINT_CHUNK_BLOCKS:-65536}"

# Incident floors may be made stricter, never weaker.
DB_MIN_FREE_BYTES_FLOOR=21474836480
ROOT_MIN_FREE_BYTES_FLOOR=10737418240
OUTPUT_MIN_FREE_BYTES_FLOOR=32212254720
DB_MAX_USED_PCT_CEILING=89
ROOT_MAX_USED_PCT_CEILING=89
CAPACITY_MAX_AGE_SECONDS_CEILING=1800
WAL_MAX_BYTES_CEILING=4294967296
WAL_MAX_GROWTH_BYTES_CEILING=1073741824
CHUNK_BLOCKS_CEILING=65536

DB_MIN_FREE_BYTES="${FINGERPRINT_DB_MIN_FREE_BYTES:-$DB_MIN_FREE_BYTES_FLOOR}"
ROOT_MIN_FREE_BYTES="${FINGERPRINT_ROOT_MIN_FREE_BYTES:-$ROOT_MIN_FREE_BYTES_FLOOR}"
OUTPUT_MIN_FREE_BYTES="${FINGERPRINT_OUTPUT_MIN_FREE_BYTES:-$OUTPUT_MIN_FREE_BYTES_FLOOR}"
DB_MAX_USED_PCT="${FINGERPRINT_DB_MAX_USED_PCT:-$DB_MAX_USED_PCT_CEILING}"
ROOT_MAX_USED_PCT="${FINGERPRINT_ROOT_MAX_USED_PCT:-$ROOT_MAX_USED_PCT_CEILING}"
CAPACITY_MAX_AGE_SECONDS="${FINGERPRINT_CAPACITY_MAX_AGE_SECONDS:-$CAPACITY_MAX_AGE_SECONDS_CEILING}"
WAL_MAX_BYTES="${FINGERPRINT_WAL_MAX_BYTES:-$WAL_MAX_BYTES_CEILING}"
WAL_MAX_GROWTH_BYTES="${FINGERPRINT_WAL_MAX_GROWTH_BYTES:-$WAL_MAX_GROWTH_BYTES_CEILING}"
DB_DISK_PATH="${FINGERPRINT_DB_DISK_PATH:-/var/lib/postgresql}"
ROOT_DISK_PATH="${FINGERPRINT_ROOT_DISK_PATH:-/}"
PREFLIGHT_BLOCKS=4096

usage() {
  cat <<'EOF'
Usage:
  adsecute-table-fingerprint-runner.sh \
    --output-dir ABSOLUTE_OFF_VOLUME_PATH \
    --writers-frozen "GLOBAL WRITERS FROZEN" \
    --off-volume-ack "OUTPUT IS OFF DB VOLUME" \
    [--table meta_entity_state_history] \
    [--db-name adsecute_prod] \
    [--chunk-blocks 65536]

The script is read-only against PostgreSQL. It writes only manifest, plan,
partial CSV, progress, final CSV, and checksum files under --output-dir.
Connection settings use normal libpq variables (PGHOST, PGPORT, PGUSER, etc.).
EOF
}

fail() {
  printf 'fingerprint runner failed: %s\n' "$1" >&2
  exit 1
}

log() {
  printf '%s\n' "$1"
}

require_uint() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$label must be an unsigned integer"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

while (($# > 0)); do
  case "$1" in
    --output-dir)
      (($# >= 2)) || fail "--output-dir requires a value"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --writers-frozen)
      (($# >= 2)) || fail "--writers-frozen requires a value"
      WRITERS_FROZEN_ACK="$2"
      shift 2
      ;;
    --off-volume-ack)
      (($# >= 2)) || fail "--off-volume-ack requires a value"
      OFF_VOLUME_ACK="$2"
      shift 2
      ;;
    --table)
      (($# >= 2)) || fail "--table requires a value"
      TABLE_NAME="$2"
      shift 2
      ;;
    --db-name)
      (($# >= 2)) || fail "--db-name requires a value"
      DB_NAME="$2"
      shift 2
      ;;
    --chunk-blocks)
      (($# >= 2)) || fail "--chunk-blocks requires a value"
      CHUNK_BLOCKS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "$WRITERS_FROZEN_ACK" == "GLOBAL WRITERS FROZEN" ]] \
  || fail 'pass --writers-frozen "GLOBAL WRITERS FROZEN" only after all writers are frozen'
[[ "$OFF_VOLUME_ACK" == "OUTPUT IS OFF DB VOLUME" ]] \
  || fail 'pass --off-volume-ack "OUTPUT IS OFF DB VOLUME" after checking the mount'
[[ "$TABLE_NAME" =~ ^[a-z_][a-z0-9_]*$ ]] \
  || fail "table must be a simple public-schema identifier"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] \
  || fail "database name contains unsupported characters"
[[ "$OUTPUT_DIR" == /* ]] || fail "output directory must be absolute"
[[ "$OUTPUT_DIR" != "/" ]] || fail "output directory cannot be /"
case "$OUTPUT_DIR/" in
  /var/lib/postgresql/*)
    fail "output directory must not be on the PostgreSQL data path"
    ;;
esac

for item in \
  "$CHUNK_BLOCKS:chunk blocks" \
  "$DB_MIN_FREE_BYTES:DB minimum free bytes" \
  "$ROOT_MIN_FREE_BYTES:root minimum free bytes" \
  "$OUTPUT_MIN_FREE_BYTES:output minimum free bytes" \
  "$DB_MAX_USED_PCT:DB maximum used percent" \
  "$ROOT_MAX_USED_PCT:root maximum used percent" \
  "$CAPACITY_MAX_AGE_SECONDS:capacity maximum age" \
  "$WAL_MAX_BYTES:WAL maximum bytes" \
  "$WAL_MAX_GROWTH_BYTES:WAL maximum growth bytes"; do
  require_uint "${item%%:*}" "${item#*:}"
done
((CHUNK_BLOCKS > 0 && CHUNK_BLOCKS <= CHUNK_BLOCKS_CEILING)) \
  || fail "chunk blocks must be in 1..$CHUNK_BLOCKS_CEILING"
((DB_MIN_FREE_BYTES >= DB_MIN_FREE_BYTES_FLOOR)) \
  || fail "DB free-space floor cannot be weakened"
((ROOT_MIN_FREE_BYTES >= ROOT_MIN_FREE_BYTES_FLOOR)) \
  || fail "root free-space floor cannot be weakened"
((OUTPUT_MIN_FREE_BYTES >= OUTPUT_MIN_FREE_BYTES_FLOOR)) \
  || fail "output free-space floor cannot be weakened"
((DB_MAX_USED_PCT <= DB_MAX_USED_PCT_CEILING)) \
  || fail "DB used-percent ceiling cannot be weakened"
((ROOT_MAX_USED_PCT <= ROOT_MAX_USED_PCT_CEILING)) \
  || fail "root used-percent ceiling cannot be weakened"
((CAPACITY_MAX_AGE_SECONDS <= CAPACITY_MAX_AGE_SECONDS_CEILING)) \
  || fail "capacity snapshot age ceiling cannot be weakened"
((WAL_MAX_BYTES <= WAL_MAX_BYTES_CEILING)) \
  || fail "WAL byte ceiling cannot be weakened"
((WAL_MAX_GROWTH_BYTES <= WAL_MAX_GROWTH_BYTES_CEILING)) \
  || fail "WAL growth ceiling cannot be weakened"

require_command "$PSQL_BIN"
require_command "$PYTHON_BIN"
require_command awk
require_command df
require_command grep
require_command mktemp

[[ -r "$CHUNK_SQL" ]] || fail "missing chunk SQL: $CHUNK_SQL"
[[ -r "$REDUCER" ]] || fail "missing reducer: $REDUCER"
install -d -m 700 -- "$OUTPUT_DIR"

psql_scalar() {
  "$PSQL_BIN" -X -qAt -F $'\t' \
    --set=ON_ERROR_STOP=1 \
    --dbname="$DB_NAME" \
    "$@"
}

capture_relation_state() {
  local raw
  if ! raw="$(
    psql_scalar --set=fingerprint_table="$TABLE_NAME" <<'SQL'
WITH target AS MATERIALIZED (
  SELECT format('public.%I', :'fingerprint_table')::regclass AS oid
),
schema_signature AS MATERIALIZED (
  SELECT md5(
    string_agg(
      concat_ws(
        ':',
        attribute.attnum,
        attribute.attname,
        attribute.atttypid,
        attribute.atttypmod,
        attribute.attnotnull
      ),
      ',' ORDER BY attribute.attnum
    )
  ) AS signature
  FROM target
  JOIN pg_attribute AS attribute
    ON attribute.attrelid = target.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
)
SELECT
  relation.relkind,
  concat(format_type(id_attribute.atttypid, id_attribute.atttypmod), ':', id_attribute.attnotnull::int),
  CASE WHEN to_regprocedure('digest(bytea,text)') IS NULL THEN 0 ELSE 1 END,
  current_setting('server_version_num'),
  pg_relation_filenode(target.oid),
  pg_relation_size(target.oid),
  current_setting('block_size')::bigint,
  (
    pg_relation_size(target.oid)
    + current_setting('block_size')::bigint
    - 1
  ) / current_setting('block_size')::bigint,
  schema_signature.signature,
  extract(epoch FROM pg_postmaster_start_time())::bigint,
  coalesce(extract(epoch FROM database_stats.stats_reset)::bigint, 0),
  coalesce(table_stats.n_tup_ins, 0),
  coalesce(table_stats.n_tup_upd, 0),
  coalesce(table_stats.n_tup_del, 0),
  coalesce(table_stats.n_tup_hot_upd, 0),
  database_stats.temp_bytes,
  database_stats.temp_files
FROM target
JOIN pg_class AS relation ON relation.oid = target.oid
JOIN pg_attribute AS id_attribute
  ON id_attribute.attrelid = target.oid
 AND id_attribute.attname = 'id'
 AND NOT id_attribute.attisdropped
CROSS JOIN schema_signature
JOIN pg_stat_database AS database_stats
  ON database_stats.datname = current_database()
LEFT JOIN pg_stat_user_tables AS table_stats
  ON table_stats.relid = target.oid;
SQL
  )"; then
    fail "could not read target-table guard state"
  fi
  [[ -n "$raw" ]] || fail "target-table guard state was empty"
  IFS=$'\t' read -r \
    CURRENT_RELKIND CURRENT_ID_CONTRACT CURRENT_DIGEST_EXISTS \
    CURRENT_SERVER_VERSION CURRENT_RELFILENODE CURRENT_RELATION_SIZE \
    CURRENT_BLOCK_SIZE CURRENT_TOTAL_BLOCKS CURRENT_SCHEMA_SIGNATURE \
    CURRENT_POSTMASTER_EPOCH CURRENT_STATS_RESET_EPOCH \
    CURRENT_N_TUP_INS CURRENT_N_TUP_UPD CURRENT_N_TUP_DEL \
    CURRENT_N_TUP_HOT_UPD CURRENT_TEMP_BYTES CURRENT_TEMP_FILES <<<"$raw"
}

capture_capacity_state() {
  local raw now_epoch age wal_growth
  if ! raw="$(
    psql_scalar \
      --set=db_disk_path="$DB_DISK_PATH" \
      --set=root_disk_path="$ROOT_DISK_PATH" <<'SQL'
WITH latest AS MATERIALIZED (
  SELECT sampled_at, payload
  FROM system_capacity_snapshots
  WHERE source = 'db_host_healthcheck'
  ORDER BY sampled_at DESC
  LIMIT 1
),
disks AS MATERIALIZED (
  SELECT disk
  FROM latest
  CROSS JOIN LATERAL jsonb_array_elements(
    coalesce(latest.payload -> 'disks', '[]'::jsonb)
  ) AS disk
)
SELECT
  extract(epoch FROM latest.sampled_at)::bigint,
  coalesce((
    SELECT (disk ->> 'availableBytes')::bigint
    FROM disks WHERE disk ->> 'path' = :'db_disk_path' LIMIT 1
  ), -1),
  coalesce((
    SELECT (disk ->> 'usedPercent')::integer
    FROM disks WHERE disk ->> 'path' = :'db_disk_path' LIMIT 1
  ), -1),
  coalesce((
    SELECT (disk ->> 'availableBytes')::bigint
    FROM disks WHERE disk ->> 'path' = :'root_disk_path' LIMIT 1
  ), -1),
  coalesce((
    SELECT (disk ->> 'usedPercent')::integer
    FROM disks WHERE disk ->> 'path' = :'root_disk_path' LIMIT 1
  ), -1),
  (SELECT coalesce(sum(size), 0)::bigint FROM pg_ls_waldir())
FROM latest;
SQL
  )"; then
    fail "could not read DB-host capacity and WAL state"
  fi
  [[ -n "$raw" ]] || fail "missing db_host_healthcheck capacity snapshot"
  IFS=$'\t' read -r \
    CURRENT_CAPACITY_EPOCH CURRENT_DB_FREE_BYTES CURRENT_DB_USED_PCT \
    CURRENT_ROOT_FREE_BYTES CURRENT_ROOT_USED_PCT CURRENT_WAL_BYTES <<<"$raw"

  now_epoch="$(date +%s)"
  age=$((now_epoch - CURRENT_CAPACITY_EPOCH))
  ((age >= 0 && age <= CAPACITY_MAX_AGE_SECONDS)) \
    || fail "capacity snapshot is stale or future-dated: age=${age}s"
  ((CURRENT_DB_FREE_BYTES >= DB_MIN_FREE_BYTES)) \
    || fail "DB free space below floor: $CURRENT_DB_FREE_BYTES"
  ((CURRENT_DB_USED_PCT <= DB_MAX_USED_PCT)) \
    || fail "DB disk usage above ceiling: ${CURRENT_DB_USED_PCT}%"
  ((CURRENT_ROOT_FREE_BYTES >= ROOT_MIN_FREE_BYTES)) \
    || fail "root free space below floor: $CURRENT_ROOT_FREE_BYTES"
  ((CURRENT_ROOT_USED_PCT <= ROOT_MAX_USED_PCT)) \
    || fail "root disk usage above ceiling: ${CURRENT_ROOT_USED_PCT}%"
  ((CURRENT_WAL_BYTES <= WAL_MAX_BYTES)) \
    || fail "pg_wal above ceiling: $CURRENT_WAL_BYTES"
  if [[ -n "${MANIFEST_INITIAL_WAL_BYTES:-}" ]]; then
    wal_growth=$((CURRENT_WAL_BYTES - MANIFEST_INITIAL_WAL_BYTES))
    ((wal_growth < 0)) && wal_growth=0
    ((wal_growth <= WAL_MAX_GROWTH_BYTES)) \
      || fail "pg_wal growth above ceiling: $wal_growth"
  fi
}

check_output_capacity() {
  local available_kib available_bytes
  available_kib="$(df -Pk "$OUTPUT_DIR" | awk 'NR == 2 {print $4}')"
  require_uint "$available_kib" "output available KiB"
  available_bytes=$((available_kib * 1024))
  ((available_bytes >= OUTPUT_MIN_FREE_BYTES)) \
    || fail "off-volume output free space below floor: $available_bytes"
}

assert_target_contract() {
  [[ "$CURRENT_RELKIND" == "r" ]] || fail "target must be an ordinary table"
  [[ "$CURRENT_ID_CONTRACT" == "uuid:1" ]] \
    || fail "target id must be NOT NULL UUID"
  [[ "$CURRENT_DIGEST_EXISTS" == "1" ]] \
    || fail "pgcrypto digest(bytea,text) is unavailable"
  ((CURRENT_TOTAL_BLOCKS > 0)) || fail "target heap is empty"
}

assert_relation_unchanged() {
  [[ "$CURRENT_RELKIND" == "$MANIFEST_RELKIND" ]] \
    || fail "target relkind changed"
  [[ "$CURRENT_ID_CONTRACT" == "$MANIFEST_ID_CONTRACT" ]] \
    || fail "target id contract changed"
  [[ "$CURRENT_DIGEST_EXISTS" == "$MANIFEST_DIGEST_EXISTS" ]] \
    || fail "digest availability changed"
  [[ "$CURRENT_SERVER_VERSION" == "$MANIFEST_SERVER_VERSION" ]] \
    || fail "server version changed"
  [[ "$CURRENT_RELFILENODE" == "$MANIFEST_RELFILENODE" ]] \
    || fail "target relfilenode changed"
  [[ "$CURRENT_RELATION_SIZE" == "$MANIFEST_RELATION_SIZE" ]] \
    || fail "target relation size changed"
  [[ "$CURRENT_BLOCK_SIZE" == "$MANIFEST_BLOCK_SIZE" ]] \
    || fail "database block size changed"
  [[ "$CURRENT_TOTAL_BLOCKS" == "$MANIFEST_TOTAL_BLOCKS" ]] \
    || fail "target block count changed"
  [[ "$CURRENT_SCHEMA_SIGNATURE" == "$MANIFEST_SCHEMA_SIGNATURE" ]] \
    || fail "target row schema changed"
  [[ "$CURRENT_POSTMASTER_EPOCH" == "$MANIFEST_POSTMASTER_EPOCH" ]] \
    || fail "PostgreSQL restarted"
  [[ "$CURRENT_STATS_RESET_EPOCH" == "$MANIFEST_STATS_RESET_EPOCH" ]] \
    || fail "database statistics were reset"
  [[ "$CURRENT_N_TUP_INS" == "$MANIFEST_N_TUP_INS" ]] \
    || fail "target insert counter changed"
  [[ "$CURRENT_N_TUP_UPD" == "$MANIFEST_N_TUP_UPD" ]] \
    || fail "target update counter changed"
  [[ "$CURRENT_N_TUP_DEL" == "$MANIFEST_N_TUP_DEL" ]] \
    || fail "target delete counter changed"
  [[ "$CURRENT_N_TUP_HOT_UPD" == "$MANIFEST_N_TUP_HOT_UPD" ]] \
    || fail "target HOT-update counter changed"
}

write_manifest() {
  local temporary_manifest
  temporary_manifest="$(mktemp "$OUTPUT_DIR/.manifest.tsv.XXXXXX")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "adsecute-table-fingerprint.v2" \
    "$TABLE_NAME" \
    "$DB_NAME" \
    "$CHUNK_BLOCKS" \
    "$CURRENT_RELKIND" \
    "$CURRENT_ID_CONTRACT" \
    "$CURRENT_DIGEST_EXISTS" \
    "$CURRENT_SERVER_VERSION" \
    "$CURRENT_RELFILENODE" \
    "$CURRENT_RELATION_SIZE" \
    "$CURRENT_BLOCK_SIZE" \
    "$CURRENT_TOTAL_BLOCKS" \
    "$CURRENT_SCHEMA_SIGNATURE" \
    "$CURRENT_POSTMASTER_EPOCH" \
    "$CURRENT_STATS_RESET_EPOCH" \
    "$CURRENT_N_TUP_INS" \
    "$CURRENT_N_TUP_UPD" \
    "$CURRENT_N_TUP_DEL" \
    "$CURRENT_N_TUP_HOT_UPD" \
    "$CURRENT_WAL_BYTES" >"$temporary_manifest"
  mv -- "$temporary_manifest" "$OUTPUT_DIR/manifest.tsv"
}

read_manifest() {
  IFS=$'\t' read -r \
    MANIFEST_CONTRACT MANIFEST_TABLE MANIFEST_DB_NAME MANIFEST_CHUNK_BLOCKS \
    MANIFEST_RELKIND MANIFEST_ID_CONTRACT MANIFEST_DIGEST_EXISTS \
    MANIFEST_SERVER_VERSION MANIFEST_RELFILENODE MANIFEST_RELATION_SIZE \
    MANIFEST_BLOCK_SIZE MANIFEST_TOTAL_BLOCKS MANIFEST_SCHEMA_SIGNATURE \
    MANIFEST_POSTMASTER_EPOCH MANIFEST_STATS_RESET_EPOCH \
    MANIFEST_N_TUP_INS MANIFEST_N_TUP_UPD MANIFEST_N_TUP_DEL \
    MANIFEST_N_TUP_HOT_UPD MANIFEST_INITIAL_WAL_BYTES \
    <"$OUTPUT_DIR/manifest.tsv"
  [[ "$MANIFEST_CONTRACT" == "adsecute-table-fingerprint.v2" ]] \
    || fail "unsupported or malformed manifest"
  [[ "$MANIFEST_TABLE" == "$TABLE_NAME" ]] || fail "manifest table mismatch"
  [[ "$MANIFEST_DB_NAME" == "$DB_NAME" ]] || fail "manifest database mismatch"
  [[ "$MANIFEST_CHUNK_BLOCKS" == "$CHUNK_BLOCKS" ]] \
    || fail "manifest chunk size mismatch"
}

quarantine_file() {
  local path="$1"
  local reason="$2"
  local quarantined="${path}.${reason}.$(date +%s)"
  mv -- "$path" "$quarantined"
  printf 'quarantined=%s\n' "$quarantined" >&2
}

run_chunk_sql() {
  local start_block="$1"
  local end_block="$2"
  local explain="$3"
  "$PSQL_BIN" -X -q \
    --set=ON_ERROR_STOP=1 \
    --dbname="$DB_NAME" \
    --set=fingerprint_table="$TABLE_NAME" \
    --set=start_block="$start_block" \
    --set=end_block="$end_block" \
    --set=fingerprint_explain="$explain" \
    --file="$CHUNK_SQL"
}

validate_preflight_plan() {
  local plan_path="$1"
  if ! grep -q "Tid Range Scan" "$plan_path"; then
    printf 'preflight did not use Tid Range Scan\n' >&2
    return 1
  fi
  if ! grep -q "Batches: 1" "$plan_path"; then
    printf 'preflight HashAggregate was not single-batch\n' >&2
    return 1
  fi
  if grep -Eq "Disk Usage|temp read=|temp written=|Sort Method: external" "$plan_path"; then
    printf 'preflight plan reported disk-backed execution\n' >&2
    return 1
  fi
}

check_output_capacity
capture_relation_state
assert_target_contract
capture_capacity_state

if [[ -f "$OUTPUT_DIR/manifest.tsv" ]]; then
  read_manifest
  assert_relation_unchanged
else
  if compgen -G "$OUTPUT_DIR/part-*-*.csv" >/dev/null; then
    fail "part files exist without a manifest"
  fi
  write_manifest
  read_manifest
fi

capture_capacity_state

if [[ ! -f "$OUTPUT_DIR/preflight.plan" ]]; then
  preflight_end="$PREFLIGHT_BLOCKS"
  ((preflight_end > MANIFEST_TOTAL_BLOCKS)) \
    && preflight_end="$MANIFEST_TOTAL_BLOCKS"
  capture_relation_state
  assert_relation_unchanged
  preflight_temp_bytes="$CURRENT_TEMP_BYTES"
  preflight_temp_files="$CURRENT_TEMP_FILES"
  preflight_tmp="$(mktemp "$OUTPUT_DIR/.preflight.plan.XXXXXX")"
  if ! run_chunk_sql 0 "$preflight_end" 1 >"$preflight_tmp"; then
    quarantine_file "$preflight_tmp" "failed"
    fail "preflight EXPLAIN failed"
  fi
  capture_relation_state
  assert_relation_unchanged
  if ! validate_preflight_plan "$preflight_tmp"; then
    quarantine_file "$preflight_tmp" "temp-plan"
    fail "preflight plan validation failed"
  fi
  mv -- "$preflight_tmp" "$OUTPUT_DIR/preflight.plan"
  if ((CURRENT_TEMP_BYTES != preflight_temp_bytes || CURRENT_TEMP_FILES != preflight_temp_files)); then
    fail "database-wide temp counters changed during preflight; the backend-clean plan was retained"
  fi
fi
validate_preflight_plan "$OUTPUT_DIR/preflight.plan" \
  || fail "saved preflight plan validation failed"

if [[ ! -f "$OUTPUT_DIR/progress.tsv" ]]; then
  printf 'start_block\tend_block\tcompleted_epoch\ttemp_bytes_before\ttemp_bytes_after\twal_bytes_before\twal_bytes_after\n' \
    >"$OUTPUT_DIR/progress.tsv"
fi

start_block=0
while ((start_block < MANIFEST_TOTAL_BLOCKS)); do
  end_block=$((start_block + CHUNK_BLOCKS))
  ((end_block > MANIFEST_TOTAL_BLOCKS)) && end_block="$MANIFEST_TOTAL_BLOCKS"
  final_part="$OUTPUT_DIR/part-$start_block-$end_block.csv"

  if [[ -f "$final_part" ]]; then
    "$PYTHON_BIN" "$REDUCER" validate-part \
      "$final_part" "$start_block" "$end_block" >/dev/null
    start_block="$end_block"
    continue
  fi

  check_output_capacity
  capture_capacity_state
  wal_before="$CURRENT_WAL_BYTES"
  capture_relation_state
  assert_relation_unchanged
  temp_bytes_before="$CURRENT_TEMP_BYTES"
  temp_files_before="$CURRENT_TEMP_FILES"

  temporary_part="$(mktemp "$OUTPUT_DIR/.part-$start_block-$end_block.XXXXXX")"
  if ! run_chunk_sql "$start_block" "$end_block" 0 >"$temporary_part"; then
    quarantine_file "$temporary_part" "failed"
    fail "chunk $start_block..$end_block failed"
  fi

  capture_relation_state
  assert_relation_unchanged
  "$PYTHON_BIN" "$REDUCER" validate-part \
    "$temporary_part" "$start_block" "$end_block" >/dev/null \
    || { quarantine_file "$temporary_part" "invalid"; fail "chunk output validation failed"; }

  mv -- "$temporary_part" "$final_part"
  capture_capacity_state
  wal_after="$CURRENT_WAL_BYTES"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$start_block" "$end_block" "$(date +%s)" \
    "$temp_bytes_before" "$CURRENT_TEMP_BYTES" \
    "$wal_before" "$wal_after" >>"$OUTPUT_DIR/progress.tsv"
  check_output_capacity
  log "fingerprint chunk complete: $start_block..$end_block"
  if ((CURRENT_TEMP_BYTES != temp_bytes_before || CURRENT_TEMP_FILES != temp_files_before)); then
    fail "database-wide temp counters changed during chunk; the backend-clean part was retained"
  fi
  start_block="$end_block"
done

"$PYTHON_BIN" "$REDUCER" reduce \
  "$OUTPUT_DIR" "$MANIFEST_TOTAL_BLOCKS" "$OUTPUT_DIR/fingerprint.csv"

if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$OUTPUT_DIR"
    sha256sum fingerprint.csv >fingerprint.csv.sha256
  )
elif command -v shasum >/dev/null 2>&1; then
  (
    cd "$OUTPUT_DIR"
    shasum -a 256 fingerprint.csv >fingerprint.csv.sha256
  )
else
  fail "fingerprint complete but neither sha256sum nor shasum is available"
fi

log "fingerprint complete: $OUTPUT_DIR/fingerprint.csv"
