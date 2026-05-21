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

runuser -u postgres -- pg_isready -h 127.0.0.1 -p 5432 -d "$DB_NAME" >/dev/null 2>&1 \
  || fail "postgres_not_ready"

latest_backup_dir="$(find "$BACKUP_ROOT/daily" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n1)"
[ -n "$latest_backup_dir" ] || fail "missing_backup_dir"

now_epoch="$(date +%s)"
backup_epoch="$(stat -c %Y "$latest_backup_dir")"
backup_age_hours="$(( (now_epoch - backup_epoch) / 3600 ))"
[ "$backup_age_hours" -le "$MAX_BACKUP_AGE_HOURS" ] || fail "backup_too_old"

disk_pct="$(df -P "$DISK_CHECK_PATH" | awk 'NR==2 {gsub("%","",$5); print $5}')"
root_disk_pct="$(df -P "$ROOT_DISK_CHECK_PATH" | awk 'NR==2 {gsub("%","",$5); print $5}')"
db_size_pretty="$(runuser -u postgres -- psql --dbname=postgres --tuples-only --no-align --command="SELECT pg_size_pretty(pg_database_size('$DB_NAME'));" | tr -d '\n')"

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
