#!/usr/bin/env bash
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/adsecute-postgres}"
DB_NAME="${DB_NAME:-adsecute_prod}"
MAX_BACKUP_AGE_HOURS="${MAX_BACKUP_AGE_HOURS:-30}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
DISK_FAIL_PCT="${DISK_FAIL_PCT:-95}"
DISK_CHECK_PATH="${DISK_CHECK_PATH:-/var/lib/postgresql}"
ROOT_DISK_CHECK_PATH="${ROOT_DISK_CHECK_PATH:-/}"

fail() {
  echo "status=fail reason=$1"
  exit 1
}

warn() {
  echo "status=warn reason=$1"
}

read_df_stats() {
  local path="$1"
  local prefix="$2"
  local line filesystem total_bytes used_bytes available_bytes capacity mounted_on
  line="$(df -P -B1 "$path" | awk 'NR==2 {print}')"
  read -r filesystem total_bytes used_bytes available_bytes capacity mounted_on <<EOF
$line
EOF
  capacity="${capacity%\%}"
  eval "${prefix}_filesystem=\"\$filesystem\""
  eval "${prefix}_total_bytes=\"\$total_bytes\""
  eval "${prefix}_used_bytes=\"\$used_bytes\""
  eval "${prefix}_available_bytes=\"\$available_bytes\""
  eval "${prefix}_used_percent=\"\$capacity\""
  eval "${prefix}_mounted_on=\"\$mounted_on\""
}

insert_capacity_snapshot() {
  local hostname_value
  hostname_value="$(hostname)"
  runuser -u postgres -- psql \
    --dbname="$DB_NAME" \
    --set=hostname="$hostname_value" \
    --set=sampled_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --set=db_name="$DB_NAME" \
    --set=db_size_bytes="$db_size_bytes" \
    --set=db_size_pretty="$db_size_pretty" \
    --set=backup_age_hours="$backup_age_hours" \
    --set=backup_path="$latest_backup_dir" \
    --set=data_path="$DISK_CHECK_PATH" \
    --set=data_filesystem="$data_filesystem" \
    --set=data_mounted_on="$data_mounted_on" \
    --set=data_total_bytes="$data_total_bytes" \
    --set=data_used_bytes="$data_used_bytes" \
    --set=data_available_bytes="$data_available_bytes" \
    --set=data_used_percent="$data_used_percent" \
    --set=root_path="$ROOT_DISK_CHECK_PATH" \
    --set=root_filesystem="$root_filesystem" \
    --set=root_mounted_on="$root_mounted_on" \
    --set=root_total_bytes="$root_total_bytes" \
    --set=root_used_bytes="$root_used_bytes" \
    --set=root_available_bytes="$root_available_bytes" \
    --set=root_used_percent="$root_used_percent" <<'SQL'
INSERT INTO system_capacity_snapshots (source, hostname, sampled_at, payload)
VALUES (
  'db_host_healthcheck',
  :'hostname',
  :'sampled_at'::timestamptz,
  jsonb_build_object(
    'sampledAt', :'sampled_at',
    'hostname', :'hostname',
    'database', jsonb_build_object(
      'name', :'db_name',
      'sizeBytes', :db_size_bytes,
      'sizePretty', :'db_size_pretty'
    ),
    'backup', jsonb_build_object(
      'latestAgeHours', :backup_age_hours,
      'latestPath', :'backup_path'
    ),
    'disks', jsonb_build_array(
      jsonb_build_object(
        'path', :'root_path',
        'filesystem', :'root_filesystem',
        'mountedOn', :'root_mounted_on',
        'totalBytes', :root_total_bytes,
        'usedBytes', :root_used_bytes,
        'availableBytes', :root_available_bytes,
        'usedPercent', :root_used_percent
      ),
      jsonb_build_object(
        'path', :'data_path',
        'filesystem', :'data_filesystem',
        'mountedOn', :'data_mounted_on',
        'totalBytes', :data_total_bytes,
        'usedBytes', :data_used_bytes,
        'availableBytes', :data_available_bytes,
        'usedPercent', :data_used_percent
      )
    )
  )
);
SQL
}

runuser -u postgres -- pg_isready -h 127.0.0.1 -p 5432 -d "$DB_NAME" >/dev/null 2>&1 \
  || fail "postgres_not_ready"

latest_backup_dir="$(find "$BACKUP_ROOT/daily" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n1)"
[ -n "$latest_backup_dir" ] || fail "missing_backup_dir"

now_epoch="$(date +%s)"
backup_epoch="$(stat -c %Y "$latest_backup_dir")"
backup_age_hours="$(( (now_epoch - backup_epoch) / 3600 ))"
[ "$backup_age_hours" -le "$MAX_BACKUP_AGE_HOURS" ] || fail "backup_too_old"

read_df_stats "$DISK_CHECK_PATH" data
read_df_stats "$ROOT_DISK_CHECK_PATH" root
disk_pct="$data_used_percent"
root_disk_pct="$root_used_percent"
db_size_bytes="$(runuser -u postgres -- psql --dbname=postgres --tuples-only --no-align --command="SELECT pg_database_size('$DB_NAME');" | tr -d '\n')"
db_size_pretty="$(runuser -u postgres -- psql --dbname=postgres --tuples-only --no-align --command="SELECT pg_size_pretty(pg_database_size('$DB_NAME'));" | tr -d '\n')"

insert_capacity_snapshot >/dev/null 2>&1 || true

if [ "$disk_pct" -ge "$DISK_FAIL_PCT" ]; then
  fail "disk_usage_critical disk_path=$DISK_CHECK_PATH disk_pct=$disk_pct root_disk_path=$ROOT_DISK_CHECK_PATH root_disk_pct=$root_disk_pct"
fi

if [ "$root_disk_pct" -ge "$DISK_FAIL_PCT" ]; then
  fail "root_disk_usage_critical disk_path=$DISK_CHECK_PATH disk_pct=$disk_pct root_disk_path=$ROOT_DISK_CHECK_PATH root_disk_pct=$root_disk_pct"
fi

if [ "$disk_pct" -ge "$DISK_WARN_PCT" ]; then
  warn "disk_usage_high disk_path=$DISK_CHECK_PATH disk_pct=$disk_pct root_disk_path=$ROOT_DISK_CHECK_PATH root_disk_pct=$root_disk_pct latest_backup_age_h=$backup_age_hours db_size=$db_size_pretty latest_backup=$latest_backup_dir"
  exit 0
fi

if [ "$root_disk_pct" -ge "$DISK_WARN_PCT" ]; then
  warn "root_disk_usage_high disk_path=$DISK_CHECK_PATH disk_pct=$disk_pct root_disk_path=$ROOT_DISK_CHECK_PATH root_disk_pct=$root_disk_pct latest_backup_age_h=$backup_age_hours db_size=$db_size_pretty latest_backup=$latest_backup_dir"
  exit 0
fi

echo "status=ok disk_path=$DISK_CHECK_PATH disk_pct=$disk_pct root_disk_path=$ROOT_DISK_CHECK_PATH root_disk_pct=$root_disk_pct latest_backup_age_h=$backup_age_hours db_size=$db_size_pretty latest_backup=$latest_backup_dir"
