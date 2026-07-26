#!/usr/bin/env bash
set -euo pipefail

umask 077

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/adsecute-postgres}"
DB_NAME="${DB_NAME:-adsecute_prod}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET_DIR="$BACKUP_ROOT/daily/$TIMESTAMP"
TMP_DIR="$BACKUP_ROOT/.tmp-$TIMESTAMP"

# Keep logical backups small by only storing irreplaceable application data.
# Warehouse, raw sync, and cache tables are rebuilt from providers after restore.
CORE_TABLES=(
  public.users
  public.businesses
  public.memberships
  public.invites
  public.provider_accounts
  public.provider_connections
  public.integration_credentials
  public.business_provider_accounts
  public.business_cost_models
  public.business_target_packs
  public.business_country_economics
  public.business_promo_calendar_events
  public.business_operating_constraints
  public.business_decision_calibration_profiles
  public.custom_reports
  public.custom_report_share_snapshots
  public.shopify_subscriptions
  public.discount_codes
  public.discount_redemptions
)

mkdir -p "$BACKUP_ROOT/daily"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

table_args=()
for table in "${CORE_TABLES[@]}"; do
  table_args+=( "--table=$table" )
done

runuser -u postgres -- pg_dump \
  --dbname="$DB_NAME" \
  --format=custom \
  --compress=9 \
  --data-only \
  --strict-names \
  --no-owner \
  --no-privileges \
  --no-tablespaces \
  "${table_args[@]}" > "$TMP_DIR/core-data.dump"

runuser -u postgres -- pg_dump \
  --dbname="$DB_NAME" \
  --format=plain \
  --schema-only \
  --no-owner \
  --no-privileges > "$TMP_DIR/schema.sql"

runuser -u postgres -- pg_dumpall --globals-only > "$TMP_DIR/globals.sql"

runuser -u postgres -- psql \
  --dbname=postgres \
  --tuples-only \
  --no-align \
  --command="SELECT pg_database_size('$DB_NAME');" > "$TMP_DIR/database_size_bytes.txt"

cat > "$TMP_DIR/manifest.txt" <<EOF
timestamp_utc=$TIMESTAMP
database=$DB_NAME
backup_scope=core_irreplaceable_tables
retention_days=$RETENTION_DAYS
table_count=${#CORE_TABLES[@]}
tables=$(printf '%s,' "${CORE_TABLES[@]}" | sed 's/,$//')
EOF

(
  cd "$TMP_DIR"
  sha256sum core-data.dump schema.sql globals.sql \
    database_size_bytes.txt manifest.txt > SHA256SUMS
)

mv "$TMP_DIR" "$TARGET_DIR"
ln -sfn "$TARGET_DIR" "$BACKUP_ROOT/latest"
find "$BACKUP_ROOT/daily" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} +

echo "backup_ok path=$TARGET_DIR"
