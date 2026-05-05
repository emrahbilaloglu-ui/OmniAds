import { getDb, getDbWithTimeout } from "@/lib/db";
import { logStartupError, logStartupEvent } from "@/lib/startup-diagnostics";

let migrationsPromise: Promise<void> | null = null;
let migrationsCompleted = false;
let loggedMigrationSkip = false;

const DEFAULT_MIGRATION_TIMEOUT_MS = 60_000;
type MigrationBatchQuery = Promise<unknown>;

function createMigrationDb(sql: ReturnType<typeof getDb>) {
  let queue = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  return Object.assign(
    ((strings: TemplateStringsArray, ...values: unknown[]) =>
      enqueue(() => sql(strings, ...values))) as ReturnType<typeof getDb>,
    {
      query: ((...args: Parameters<ReturnType<typeof getDb>["query"]>) =>
        enqueue(() => sql.query(...args))) as ReturnType<typeof getDb>["query"],
    },
  );
}

async function runMigrationBatchSequentially(queries: MigrationBatchQuery[]) {
  for (const query of queries) {
    await query;
  }
}

function runtimeMigrationsEnabled() {
  const explicit = process.env.ENABLE_RUNTIME_MIGRATIONS?.trim().toLowerCase();
  if (explicit === "1" || explicit === "true") return true;
  if (explicit === "0" || explicit === "false") return false;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

function getMigrationTimeoutMs() {
  const raw = process.env.MIGRATION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_MIGRATION_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIGRATION_TIMEOUT_MS;
}

function withMigrationTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Database migrations timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      promise.finally(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
    }),
  ]);
}

function buildGoogleAdsWarehouseTableQuery(tableName: string) {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id       TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      date              DATE NOT NULL,
      account_timezone  TEXT NOT NULL DEFAULT 'UTC',
      account_currency  TEXT NOT NULL DEFAULT 'USD',
      entity_key        TEXT NOT NULL,
      entity_label      TEXT,
      campaign_id       TEXT,
      campaign_name     TEXT,
      ad_group_id       TEXT,
      ad_group_name     TEXT,
      status            TEXT,
      channel           TEXT,
      classification    TEXT,
      payload_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
      spend             NUMERIC(18, 4) NOT NULL DEFAULT 0,
      revenue           NUMERIC(18, 4) NOT NULL DEFAULT 0,
      conversions       NUMERIC(18, 4) NOT NULL DEFAULT 0,
      impressions       BIGINT NOT NULL DEFAULT 0,
      clicks            BIGINT NOT NULL DEFAULT 0,
      ctr               NUMERIC(18, 4),
      cpc               NUMERIC(18, 4),
      cpa               NUMERIC(18, 4),
      roas              NUMERIC(18, 4) NOT NULL DEFAULT 0,
      conversion_rate   NUMERIC(18, 4),
      interaction_rate  NUMERIC(18, 4),
      source_snapshot_id UUID REFERENCES google_ads_raw_snapshots(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (business_id, provider_account_id, date, entity_key)
    )
  `;
}

function buildGoogleAdsWarehouseIndexQueries(tableName: string) {
  return [
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_business_date ON ${tableName} (business_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_account_date ON ${tableName} (provider_account_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_business_account_date ON ${tableName} (business_id, provider_account_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_business_date_entity ON ${tableName} (business_id, date DESC, entity_key)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_campaign_date ON ${tableName} (campaign_id, date DESC)`,
  ];
}

function legacyCoreCompatTablesEnabled() {
  return process.env.DB_ENABLE_LEGACY_CORE_COMPAT_TABLES?.trim() === "1";
}

function legacyCoreTableDropEnabled() {
  return process.env.DB_DROP_LEGACY_CORE_TABLES?.trim() === "1";
}

async function doesTableExist(
  sql: ReturnType<typeof createMigrationDb>,
  tableName: string,
): Promise<boolean> {
  const rows = (await sql.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`public.${tableName}`],
  )) as Array<{ exists?: boolean }>;
  return rows[0]?.exists === true;
}

function buildProviderAccountSeedUnionQuery(
  tableNames: readonly string[],
  columnName: string,
) {
  return tableNames
    .map(
      (tableName) => `
        SELECT NULLIF(TRIM(${columnName}), '') AS external_account_id
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
      `,
    )
    .join("\nUNION\n");
}

const META_CANONICAL_PROVIDER_REF_TABLES = [
  "meta_account_daily",
  "meta_campaign_daily",
  "meta_adset_daily",
  "meta_breakdown_daily",
  "meta_ad_daily",
  "meta_creative_daily",
  "meta_creative_media",
  "meta_campaign_dimensions",
  "meta_campaign_config_history",
  "meta_adset_dimensions",
  "meta_adset_config_history",
  "meta_ad_dimensions",
  "meta_creative_dimensions",
] as const;

const GOOGLE_ADS_CANONICAL_PROVIDER_REF_TABLES = [
  "google_ads_account_daily",
  "google_ads_campaign_daily",
  "google_ads_ad_group_daily",
  "google_ads_ad_daily",
  "google_ads_keyword_daily",
  "google_ads_search_term_daily",
  "google_ads_asset_group_daily",
  "google_ads_asset_daily",
  "google_ads_audience_daily",
  "google_ads_geo_daily",
  "google_ads_device_daily",
  "google_ads_product_daily",
  "google_ads_campaign_dimensions",
  "google_ads_campaign_state_history",
  "google_ads_ad_group_dimensions",
  "google_ads_ad_group_state_history",
  "google_ads_ad_dimensions",
  "google_ads_keyword_dimensions",
  "google_ads_asset_group_dimensions",
  "google_ads_product_dimensions",
] as const;

const SHOPIFY_CANONICAL_PROVIDER_REF_TABLES = [
  "shopify_raw_snapshots",
  "shopify_entity_payload_archives",
  "shopify_shop_dimensions",
  "shopify_customer_dimensions",
  "shopify_product_dimensions",
  "shopify_variant_dimensions",
  "shopify_orders",
  "shopify_order_lines",
  "shopify_refunds",
  "shopify_order_transactions",
  "shopify_returns",
  "shopify_customer_events",
  "shopify_sales_events",
  "shopify_serving_overrides",
  "shopify_webhook_deliveries",
  "shopify_repair_intents",
  "shopify_reconciliation_runs",
  "shopify_serving_state",
  "shopify_serving_state_history",
] as const;

const META_AUTHORITATIVE_CANONICAL_PROVIDER_REF_TABLES = [
  "meta_creative_score_snapshots",
  "meta_authoritative_source_manifests",
  "meta_authoritative_slice_versions",
  "meta_authoritative_publication_pointers",
  "meta_authoritative_reconciliation_events",
  "meta_authoritative_day_state",
] as const;

const META_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES = [
  "meta_config_snapshots",
] as const;

const GOOGLE_ADS_SEARCH_INTELLIGENCE_CANONICAL_PROVIDER_REF_TABLES = [
  "google_ads_search_query_hot_daily",
  "google_ads_top_query_weekly",
  "google_ads_search_cluster_daily",
  "google_ads_decision_action_outcome_logs",
] as const;

const GOOGLE_ADS_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES = [
  "google_ads_advisor_memory",
  "google_ads_advisor_execution_logs",
  "google_ads_advisor_snapshots",
] as const;

const META_CONTROL_CANONICAL_PROVIDER_REF_TABLES = [
  "meta_sync_jobs",
  "meta_sync_partitions",
  "meta_sync_runs",
  "meta_sync_checkpoints",
  "meta_sync_phase_timings",
  "meta_sync_state",
  "meta_raw_snapshots",
] as const;

const GOOGLE_ADS_CONTROL_CANONICAL_PROVIDER_REF_TABLES = [
  "google_ads_sync_jobs",
  "google_ads_sync_partitions",
  "google_ads_sync_runs",
  "google_ads_sync_checkpoints",
  "google_ads_sync_state",
  "google_ads_raw_snapshots",
] as const;

const SHOPIFY_CONTROL_CANONICAL_PROVIDER_REF_TABLES = [
  "shopify_sync_state",
] as const;

const META_PROVIDER_ACCOUNT_SEED_TABLES = [
  ...META_CANONICAL_PROVIDER_REF_TABLES,
  ...META_AUTHORITATIVE_CANONICAL_PROVIDER_REF_TABLES,
  ...META_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
] as const;

const GOOGLE_PROVIDER_ACCOUNT_SEED_TABLES = [
  ...GOOGLE_ADS_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_SEARCH_INTELLIGENCE_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
] as const;

const SHOPIFY_PROVIDER_ACCOUNT_SEED_TABLES = [
  ...SHOPIFY_CANONICAL_PROVIDER_REF_TABLES,
  ...SHOPIFY_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
] as const;

const GENERIC_CANONICAL_PROVIDER_REF_TABLES = [
  "provider_account_rollover_state",
] as const;

const BUSINESS_ONLY_CANONICAL_REF_TABLES = [
  "ai_daily_insights",
  "business_cost_models",
  "provider_connections",
  "business_provider_accounts",
  "provider_account_snapshot_runs",
  "business_target_packs",
  "business_country_economics",
  "business_promo_calendar_events",
  "business_operating_constraints",
  "business_decision_calibration_profiles",
  "command_center_mutation_receipts",
  "command_center_saved_views",
  "command_center_handoffs",
  "command_center_feedback",
  "command_center_action_journal",
  "command_center_action_state",
  "command_center_action_execution_state",
  "command_center_action_execution_audit",
  "custom_reports",
  "discount_redemptions",
  "meta_creatives_snapshots",
  "seo_ai_monthly_analyses",
  "seo_results_cache",
  "provider_cooldown_state",
  "provider_sync_jobs",
  "provider_quota_usage",
  "provider_request_audit_daily",
  "sync_runner_leases",
  "google_ads_runner_leases",
] as const;

const CANONICAL_PROVIDER_REF_TABLES = [
  ...META_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_CANONICAL_PROVIDER_REF_TABLES,
  ...META_AUTHORITATIVE_CANONICAL_PROVIDER_REF_TABLES,
  ...META_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_SEARCH_INTELLIGENCE_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES,
  ...META_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
  ...SHOPIFY_CANONICAL_PROVIDER_REF_TABLES,
  ...SHOPIFY_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
  ...GENERIC_CANONICAL_PROVIDER_REF_TABLES,
  "platform_overview_daily_summary",
] as const;

const CANONICAL_BUSINESS_REF_TABLES = [
  ...CANONICAL_PROVIDER_REF_TABLES,
  ...BUSINESS_ONLY_CANONICAL_REF_TABLES,
  "provider_reporting_snapshots",
  "platform_overview_summary_ranges",
] as const;

export async function runMigrations(options?: {
  force?: boolean;
  reason?: string;
  timeoutMs?: number;
}) {
  const force = options?.force ?? false;
  const reason = options?.reason ?? "unspecified";

  if (!force && !runtimeMigrationsEnabled()) {
    if (!loggedMigrationSkip) {
      loggedMigrationSkip = true;
      logStartupEvent("migrations_skipped_runtime_disabled", { reason, nodeEnv: process.env.NODE_ENV });
    }
    return;
  }

  if (migrationsCompleted) return;
  if (migrationsPromise) {
    await migrationsPromise;
    return;
  }

  const timeoutMs = options?.timeoutMs ?? getMigrationTimeoutMs();
  logStartupEvent("migrations_started", { reason, force, timeoutMs });

  migrationsPromise = withMigrationTimeout(
    (async () => {
      const sql = createMigrationDb(
        options?.timeoutMs != null ? getDbWithTimeout(options.timeoutMs) : getDb()
      );

      await sql.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
      const legacyCompatEnabled =
        legacyCoreCompatTablesEnabled() && !legacyCoreTableDropEnabled();
      const legacyCoreDropEnabled = legacyCoreTableDropEnabled();
      const [legacyIntegrationsExists, legacyAssignmentsExists, legacySnapshotsExists] =
        await Promise.all([
          doesTableExist(sql, "integrations"),
          doesTableExist(sql, "provider_account_assignments"),
          doesTableExist(sql, "provider_account_snapshots"),
        ]);
      const legacyIntegrationsAvailable = legacyCompatEnabled || legacyIntegrationsExists;
      const legacyAssignmentsAvailable = legacyCompatEnabled || legacyAssignmentsExists;
      const legacySnapshotsAvailable = legacyCompatEnabled || legacySnapshotsExists;

      // ── PHASE 1: Tables with no FK dependencies (ordered batch) ───────────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS users (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name          TEXT NOT NULL,
          email         TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          avatar        TEXT,
          language      TEXT NOT NULL DEFAULT 'en',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        ...(legacyCompatEnabled
          ? [sql`CREATE TABLE IF NOT EXISTS integrations (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id           TEXT NOT NULL,
          provider              TEXT NOT NULL,
          status                TEXT NOT NULL DEFAULT 'disconnected',
          provider_account_id   TEXT,
          provider_account_name TEXT,
          access_token          TEXT,
          refresh_token         TEXT,
          token_expires_at      TIMESTAMPTZ,
          scopes                TEXT,
          error_message         TEXT,
          connected_at          TIMESTAMPTZ,
          disconnected_at       TIMESTAMPTZ,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
        )`]
          : []),
        ...(legacyCompatEnabled
          ? [sql`CREATE TABLE IF NOT EXISTS provider_account_assignments (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          provider    TEXT NOT NULL,
          account_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`]
          : []),
        ...(legacyCompatEnabled
          ? [sql`CREATE TABLE IF NOT EXISTS provider_account_snapshots (
          id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id      TEXT NOT NULL,
          provider         TEXT NOT NULL,
          accounts_payload JSONB NOT NULL DEFAULT '[]'::jsonb,
          fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          refresh_failed   BOOLEAN NOT NULL DEFAULT FALSE,
          last_error       TEXT,
          refresh_requested_at TIMESTAMPTZ,
          last_refresh_attempt_at TIMESTAMPTZ,
          next_refresh_after TIMESTAMPTZ,
          refresh_in_progress BOOLEAN NOT NULL DEFAULT FALSE,
          accounts_hash     TEXT,
          source_reason     TEXT,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )`]
          : []),
        sql`CREATE TABLE IF NOT EXISTS provider_accounts (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider            TEXT NOT NULL,
          external_account_id TEXT NOT NULL,
          account_name        TEXT,
          currency            TEXT,
          timezone            TEXT,
          is_manager          BOOLEAN,
          metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (provider, external_account_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS provider_connections (
          id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id            TEXT NOT NULL,
          provider               TEXT NOT NULL,
          status                 TEXT NOT NULL DEFAULT 'disconnected',
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          provider_account_id    TEXT,
          provider_account_name  TEXT,
          connected_at           TIMESTAMPTZ,
          disconnected_at        TIMESTAMPTZ,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider)
        )`,
        sql`CREATE TABLE IF NOT EXISTS integration_credentials (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
          access_token          TEXT,
          refresh_token         TEXT,
          token_expires_at      TIMESTAMPTZ,
          scopes                TEXT,
          error_message         TEXT,
          metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (provider_connection_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_provider_accounts (
          id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id            TEXT NOT NULL,
          provider               TEXT NOT NULL,
          provider_account_ref_id UUID NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
          provider_account_id    TEXT NOT NULL,
          position               INTEGER NOT NULL DEFAULT 0,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider, provider_account_ref_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS provider_account_snapshot_runs (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id              TEXT NOT NULL,
          provider                 TEXT NOT NULL,
          fetched_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          refresh_failed           BOOLEAN NOT NULL DEFAULT FALSE,
          last_error               TEXT,
          refresh_requested_at     TIMESTAMPTZ,
          last_refresh_attempt_at  TIMESTAMPTZ,
          next_refresh_after       TIMESTAMPTZ,
          refresh_in_progress      BOOLEAN NOT NULL DEFAULT FALSE,
          accounts_hash            TEXT,
          source_reason            TEXT,
          last_successful_refresh_at TIMESTAMPTZ,
          refresh_failure_streak   INTEGER NOT NULL DEFAULT 0,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider)
        )`,
        sql`CREATE TABLE IF NOT EXISTS provider_account_snapshot_items (
          id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          snapshot_run_id        UUID NOT NULL REFERENCES provider_account_snapshot_runs(id) ON DELETE CASCADE,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          provider_account_id    TEXT NOT NULL,
          provider_account_name  TEXT NOT NULL,
          currency               TEXT,
          timezone               TEXT,
          is_manager             BOOLEAN,
          position               INTEGER NOT NULL DEFAULT 0,
          raw_payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (snapshot_run_id, provider_account_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS provider_account_rollover_state (
          provider                 TEXT NOT NULL,
          business_id              TEXT NOT NULL,
          provider_account_id      TEXT NOT NULL,
          last_observed_current_date DATE NOT NULL,
          current_d1_target_date   DATE NOT NULL,
          rollover_detected_at     TIMESTAMPTZ,
          d1_finalize_started_at   TIMESTAMPTZ,
          d1_finalize_completed_at TIMESTAMPTZ,
          last_recovery_at         TIMESTAMPTZ,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (provider, business_id, provider_account_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS provider_reporting_snapshots (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id    TEXT NOT NULL,
          provider       TEXT NOT NULL,
          report_type    TEXT NOT NULL,
          date_range_key TEXT NOT NULL,
          payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS meta_config_snapshots (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id   TEXT NOT NULL,
          account_id    TEXT NOT NULL,
          entity_level  TEXT NOT NULL CHECK (entity_level IN ('campaign', 'adset')),
          entity_id     TEXT NOT NULL,
          payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
          snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
          captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS creative_share_snapshots (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          token      TEXT NOT NULL UNIQUE,
          payload    JSONB NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS creative_decision_os_snapshots (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          surface                   TEXT NOT NULL DEFAULT 'creative',
          business_id               TEXT NOT NULL,
          analysis_scope            TEXT NOT NULL CHECK (analysis_scope IN ('account', 'campaign')),
          analysis_scope_id         TEXT,
          analysis_scope_label      TEXT NOT NULL,
          benchmark_scope           TEXT NOT NULL CHECK (benchmark_scope IN ('account', 'campaign')),
          benchmark_scope_id        TEXT,
          benchmark_scope_label     TEXT NOT NULL,
          decision_as_of            DATE,
          generated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          generated_by              TEXT,
          source_window             JSONB NOT NULL DEFAULT '{}'::jsonb,
          operator_decision_version TEXT,
          policy_version            TEXT,
          instruction_version       TEXT,
          input_hash                TEXT,
          evidence_hash             TEXT,
          summary_counts            JSONB NOT NULL DEFAULT '{}'::jsonb,
          status                    TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'error')),
          error_json                JSONB,
          payload                   JSONB,
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_provider_account_rollover_state_business
          ON provider_account_rollover_state (business_id, provider, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_account_rollover_state_target
          ON provider_account_rollover_state (provider, current_d1_target_date DESC, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS custom_reports (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          name        TEXT NOT NULL,
          description TEXT,
          template_id TEXT,
          definition  JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS custom_report_share_snapshots (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          token      TEXT NOT NULL UNIQUE,
          report_id  TEXT,
          payload    JSONB NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS creative_media_cache (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          creative_id     TEXT NOT NULL,
          business_id     TEXT NOT NULL,
          provider        TEXT NOT NULL DEFAULT 'meta',
          source_url      TEXT NOT NULL,
          storage_key     TEXT UNIQUE,
          content_type    TEXT,
          file_size_bytes INTEGER,
          status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'downloading', 'cached', 'failed')),
          error_message   TEXT,
          retry_count     INTEGER NOT NULL DEFAULT 0,
          cached_at       TIMESTAMPTZ,
          expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS meta_creatives_snapshots (
          id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          snapshot_key           TEXT NOT NULL UNIQUE,
          business_id            TEXT NOT NULL,
          assigned_accounts_hash TEXT NOT NULL,
          start_date             DATE NOT NULL,
          end_date               DATE NOT NULL,
          group_by               TEXT NOT NULL,
          format                 TEXT NOT NULL,
          sort                   TEXT NOT NULL,
          payload                JSONB NOT NULL,
          snapshot_level         TEXT NOT NULL CHECK (snapshot_level IN ('metadata', 'full')),
          row_count              INTEGER NOT NULL DEFAULT 0,
          preview_ready_count    INTEGER NOT NULL DEFAULT 0,
          last_synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          refresh_started_at     TIMESTAMPTZ,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS shopify_subscriptions (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          shop_id       TEXT NOT NULL UNIQUE,
          plan_id       TEXT NOT NULL,
          status        TEXT NOT NULL,
          billing_cycle TEXT NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS ai_daily_insights (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id     TEXT NOT NULL,
          insight_date    DATE NOT NULL,
          locale          TEXT NOT NULL DEFAULT 'en',
          summary         TEXT NOT NULL DEFAULT '',
          risks           JSONB NOT NULL DEFAULT '[]'::jsonb,
          opportunities   JSONB NOT NULL DEFAULT '[]'::jsonb,
          recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
          raw_response    JSONB,
          status          TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed')),
          error_message   TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS ai_creative_decisions_cache (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id    TEXT NOT NULL,
          analysis_key   TEXT NOT NULL,
          locale         TEXT NOT NULL DEFAULT 'en',
          currency       TEXT NOT NULL DEFAULT 'USD',
          creative_count INTEGER NOT NULL DEFAULT 0,
          decisions      JSONB NOT NULL DEFAULT '[]'::jsonb,
          source         TEXT NOT NULL DEFAULT 'deterministic' CHECK (source IN ('deterministic', 'fallback')),
          warning        TEXT,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS seo_ai_monthly_analyses (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id    TEXT NOT NULL,
          analysis_month DATE NOT NULL,
          period_start   DATE NOT NULL,
          period_end     DATE NOT NULL,
          analysis       JSONB,
          raw_response   JSONB,
          status         TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed')),
          error_message  TEXT,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS google_ads_advisor_memory (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          account_id                 TEXT NOT NULL,
          recommendation_fingerprint TEXT NOT NULL,
          recommendation_type        TEXT NOT NULL,
          entity_id                  TEXT,
          first_seen_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          prior_status               TEXT,
          current_status             TEXT NOT NULL DEFAULT 'new',
          seen_count                 INTEGER NOT NULL DEFAULT 1,
          last_do_bucket             TEXT NOT NULL DEFAULT 'do_later',
          user_action                TEXT,
          dismiss_reason             TEXT,
          suppress_until             TIMESTAMPTZ,
          applied_at                 TIMESTAMPTZ,
          outcome_check_at           TIMESTAMPTZ,
          outcome_check_window_days  INTEGER,
          outcome_verdict            TEXT,
          outcome_metric             TEXT,
          outcome_delta              NUMERIC(18, 4),
          outcome_verdict_fail_reason TEXT,
          outcome_confidence         TEXT,
          execution_status           TEXT,
          executed_at                TIMESTAMPTZ,
          execution_error            TEXT,
          rollback_available         BOOLEAN,
          rollback_executed_at       TIMESTAMPTZ,
          completion_mode            TEXT,
          completed_step_count       INTEGER,
          total_step_count           INTEGER,
          completed_step_ids         JSONB,
          skipped_step_ids           JSONB,
          core_step_ids              JSONB,
          execution_metadata         JSONB,
          applied_snapshot           JSONB,
          recommendation_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, account_id, recommendation_fingerprint)
        )`,
        sql`CREATE TABLE IF NOT EXISTS google_ads_advisor_execution_logs (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          account_id                 TEXT NOT NULL,
          recommendation_fingerprint TEXT NOT NULL,
          mutate_action_type         TEXT NOT NULL,
          operation                  TEXT NOT NULL,
          status                     TEXT NOT NULL,
          payload_json               JSONB,
          response_json              JSONB,
          error_message              TEXT,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS google_ads_advisor_snapshots (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id           TEXT NOT NULL,
          account_id            TEXT,
          analysis_version      TEXT NOT NULL DEFAULT 'v1',
          analysis_mode         TEXT NOT NULL DEFAULT 'snapshot',
          as_of_date            DATE NOT NULL,
          selected_window_key   TEXT NOT NULL DEFAULT 'last90',
          advisor_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
          historical_support_json JSONB,
          source_max_updated_at TIMESTAMPTZ,
          status                TEXT NOT NULL DEFAULT 'success',
          error_message         TEXT,
          generated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, account_id, as_of_date, analysis_version)
        )`,
      ]);

      // ── PHASE 2: businesses (deps: users) + alter phase-1 tables ──────────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS businesses (
          id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name             TEXT NOT NULL,
          owner_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          timezone         TEXT,
          timezone_source  TEXT,
          currency         TEXT NOT NULL DEFAULT 'USD',
          is_demo_business BOOLEAN NOT NULL DEFAULT FALSE,
          industry         TEXT,
          platform         TEXT,
          metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS facebook_id TEXT`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password'`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en'`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT false`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_override TEXT`,
        sql`ALTER TABLE businesses ALTER COLUMN timezone DROP NOT NULL`.catch(() => {}),
        sql`ALTER TABLE businesses ALTER COLUMN timezone DROP DEFAULT`.catch(() => {}),
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS timezone_source TEXT`.catch(() => {}),
        ...(legacyIntegrationsAvailable
          ? [
              sql`ALTER TABLE integrations ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`,
              sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_biz_provider ON integrations (business_id, provider)`.catch(() => {}),
              sql`CREATE INDEX IF NOT EXISTS idx_integrations_business_id ON integrations (business_id)`.catch(() => {}),
            ]
          : []),
        ...(legacyAssignmentsAvailable
          ? [sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_account_assignments_biz_provider ON provider_account_assignments (business_id, provider)`.catch(() => {})]
          : []),
        ...(legacySnapshotsAvailable
          ? [
              sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_account_snapshots_biz_provider ON provider_account_snapshots (business_id, provider)`.catch(() => {}),
              sql`CREATE INDEX IF NOT EXISTS idx_provider_account_snapshots_business ON provider_account_snapshots (business_id)`.catch(() => {}),
              sql`CREATE INDEX IF NOT EXISTS idx_provider_account_snapshots_next_refresh ON provider_account_snapshots (next_refresh_after)`.catch(() => {}),
            ]
          : []),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_external ON provider_accounts (provider, external_account_id)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_connections_business_provider ON provider_connections (business_id, provider)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_credentials_connection ON integration_credentials (provider_connection_id)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_business_provider_accounts_business_provider_account ON business_provider_accounts (business_id, provider, provider_account_ref_id)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_account_snapshot_runs_business_provider ON provider_account_snapshot_runs (business_id, provider)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_account_snapshot_items_run_account ON provider_account_snapshot_items (snapshot_run_id, provider_account_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_business_provider_accounts_business_provider ON business_provider_accounts (business_id, provider, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_account_snapshot_items_run_position ON provider_account_snapshot_items (snapshot_run_id, position ASC)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_reporting_snapshots_lookup ON provider_reporting_snapshots (business_id, provider, report_type, date_range_key)`.catch(() => {}),
        sql`
          UPDATE businesses AS business
          SET
            timezone = derived.timezone,
            timezone_source = derived.timezone_source
          FROM (
            SELECT
              b.id AS business_id,
              CASE
                WHEN NULLIF(shopify.metadata->>'iana_timezone', '') IS NOT NULL
                  THEN shopify.metadata->>'iana_timezone'
                WHEN NULLIF(ga4.metadata->>'ga4PropertyTimeZone', '') IS NOT NULL
                  THEN ga4.metadata->>'ga4PropertyTimeZone'
                ELSE NULL
              END AS timezone,
              CASE
                WHEN NULLIF(shopify.metadata->>'iana_timezone', '') IS NOT NULL THEN 'shopify'
                WHEN NULLIF(ga4.metadata->>'ga4PropertyTimeZone', '') IS NOT NULL THEN 'ga4'
                ELSE NULL
              END AS timezone_source
            FROM businesses b
            LEFT JOIN (
              SELECT
                pc.business_id,
                pc.provider,
                pc.status,
                COALESCE(ic.metadata, '{}'::jsonb) AS metadata
              FROM provider_connections pc
              LEFT JOIN integration_credentials ic
                ON ic.provider_connection_id = pc.id
            ) shopify
              ON shopify.business_id = b.id::text
             AND shopify.provider = 'shopify'
             AND shopify.status = 'connected'
            LEFT JOIN (
              SELECT
                pc.business_id,
                pc.provider,
                pc.status,
                COALESCE(ic.metadata, '{}'::jsonb) AS metadata
              FROM provider_connections pc
              LEFT JOIN integration_credentials ic
                ON ic.provider_connection_id = pc.id
            ) ga4
              ON ga4.business_id = b.id::text
             AND ga4.provider = 'ga4'
             AND ga4.status = 'connected'
          ) AS derived
          WHERE business.id = derived.business_id
            AND (
              business.timezone IS DISTINCT FROM derived.timezone
              OR business.timezone_source IS DISTINCT FROM derived.timezone_source
            )
        `.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_reporting_snapshots_business ON provider_reporting_snapshots (business_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_config_snapshots_lookup ON meta_config_snapshots (business_id, entity_level, entity_id, captured_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_share_snapshots_token ON creative_share_snapshots (token)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_decision_os_snapshots_scope
          ON creative_decision_os_snapshots (
            business_id,
            surface,
            analysis_scope,
            COALESCE(analysis_scope_id, ''),
            benchmark_scope,
            COALESCE(benchmark_scope_id, ''),
            generated_at DESC
          )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_custom_reports_business ON custom_reports (business_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_custom_report_share_snapshots_token ON custom_report_share_snapshots (token)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_creative_media_cache_creative_biz ON creative_media_cache (creative_id, business_id, provider)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_media_cache_status ON creative_media_cache (status)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_media_cache_storage_key ON creative_media_cache (storage_key)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_media_cache_expires ON creative_media_cache (expires_at)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creatives_snapshots_business ON meta_creatives_snapshots (business_id, last_synced_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creatives_snapshots_refresh ON meta_creatives_snapshots (refresh_started_at)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_subscriptions_shop_id ON shopify_subscriptions (shop_id)`.catch(() => {}),
        sql`ALTER TABLE ai_daily_insights ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en'`.catch(() => {}),
        sql`ALTER TABLE ai_creative_decisions_cache ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en'`.catch(() => {}),
        sql`ALTER TABLE ai_creative_decisions_cache DROP CONSTRAINT IF EXISTS ai_creative_decisions_cache_source_check`.catch(() => {}),
        sql`UPDATE ai_creative_decisions_cache SET source = 'deterministic' WHERE source = 'ai'`.catch(() => {}),
        sql`ALTER TABLE ai_creative_decisions_cache ALTER COLUMN source SET DEFAULT 'deterministic'`.catch(() => {}),
        sql`ALTER TABLE ai_creative_decisions_cache ADD CONSTRAINT ai_creative_decisions_cache_source_check CHECK (source IN ('deterministic', 'fallback'))`.catch(() => {}),
        sql`DROP INDEX IF EXISTS idx_ai_daily_insights_biz_date`.catch(() => {}),
        sql`DROP INDEX IF EXISTS idx_ai_creative_decisions_cache_business_analysis`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_daily_insights_biz_date_locale ON ai_daily_insights (business_id, insight_date, locale)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_ai_daily_insights_business ON ai_daily_insights (business_id, insight_date DESC)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_creative_decisions_cache_business_analysis_locale ON ai_creative_decisions_cache (business_id, analysis_key, locale)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_ai_creative_decisions_cache_business_updated ON ai_creative_decisions_cache (business_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_seo_ai_monthly_analyses_business_month ON seo_ai_monthly_analyses (business_id, analysis_month)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_seo_ai_monthly_analyses_business_updated ON seo_ai_monthly_analyses (business_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_memory_scope ON google_ads_advisor_memory (business_id, account_id, last_seen_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_memory_suppress_until ON google_ads_advisor_memory (suppress_until)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_memory_status ON google_ads_advisor_memory (current_status, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_memory_outcome_check ON google_ads_advisor_memory (outcome_check_at)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_execution_logs_scope ON google_ads_advisor_execution_logs (business_id, account_id, created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_execution_logs_created_at ON google_ads_advisor_execution_logs (created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_snapshots_scope ON google_ads_advisor_snapshots (business_id, account_id, generated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_snapshots_status ON google_ads_advisor_snapshots (status, updated_at DESC)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id) WHERE google_id IS NOT NULL`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_facebook_id ON users (facebook_id) WHERE facebook_id IS NOT NULL`.catch(() => {}),
      ]);

      // ── PHASE 2.5: Backfill canonical provider-account backbone ─────────
      const providerAccountLegacySeedSources: string[] = [];
      if (legacyIntegrationsAvailable) {
        providerAccountLegacySeedSources.push(`
          SELECT
            i.provider,
            NULLIF(i.provider_account_id, '') AS external_account_id,
            NULLIF(i.provider_account_name, '') AS account_name,
            NULL::TEXT AS currency,
            NULL::TEXT AS timezone,
            NULL::BOOLEAN AS is_manager,
            COALESCE(i.metadata, '{}'::jsonb) AS metadata,
            1 AS source_rank
          FROM integrations i
          WHERE NULLIF(i.provider_account_id, '') IS NOT NULL
        `);
      }
      if (legacySnapshotsAvailable) {
        providerAccountLegacySeedSources.push(`
          SELECT
            s.provider,
            NULLIF(item->>'id', '') AS external_account_id,
            NULLIF(item->>'name', '') AS account_name,
            NULLIF(item->>'currency', '') AS currency,
            NULLIF(item->>'timezone', '') AS timezone,
            CASE
              WHEN item ? 'isManager' THEN (item->>'isManager')::BOOLEAN
              ELSE NULL
            END AS is_manager,
            item AS metadata,
            2 AS source_rank
          FROM provider_account_snapshots s
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.accounts_payload, '[]'::jsonb)) AS item
          WHERE NULLIF(item->>'id', '') IS NOT NULL
        `);
      }
      if (legacyAssignmentsAvailable) {
        providerAccountLegacySeedSources.push(`
          SELECT
            a.provider,
            NULLIF(account_id, '') AS external_account_id,
            NULL::TEXT AS account_name,
            NULL::TEXT AS currency,
            NULL::TEXT AS timezone,
            NULL::BOOLEAN AS is_manager,
            '{}'::jsonb AS metadata,
            3 AS source_rank
          FROM provider_account_assignments a
          CROSS JOIN LATERAL unnest(COALESCE(a.account_ids, ARRAY[]::TEXT[])) AS account_id
          WHERE NULLIF(account_id, '') IS NOT NULL
        `);
      }
      await runMigrationBatchSequentially([
        ...(providerAccountLegacySeedSources.length > 0
          ? [sql.query(`
          INSERT INTO provider_accounts (
            provider,
            external_account_id,
            account_name,
            currency,
            timezone,
            is_manager,
            metadata,
            created_at,
            updated_at
          )
          SELECT DISTINCT ON (provider, external_account_id)
            provider,
            external_account_id,
            account_name,
            currency,
            timezone,
            is_manager,
            metadata,
            now(),
            now()
          FROM (
            ${providerAccountLegacySeedSources.join("\nUNION ALL\n")}
          ) AS source
          WHERE external_account_id IS NOT NULL
          ORDER BY provider, external_account_id, source_rank
          ON CONFLICT (provider, external_account_id) DO UPDATE SET
            account_name = COALESCE(EXCLUDED.account_name, provider_accounts.account_name),
            currency = COALESCE(EXCLUDED.currency, provider_accounts.currency),
            timezone = COALESCE(EXCLUDED.timezone, provider_accounts.timezone),
            is_manager = COALESCE(EXCLUDED.is_manager, provider_accounts.is_manager),
            metadata = CASE
              WHEN EXCLUDED.metadata = '{}'::jsonb THEN provider_accounts.metadata
              ELSE provider_accounts.metadata || EXCLUDED.metadata
            END,
            updated_at = now()
        `)]
          : []),
        ...(legacyIntegrationsAvailable
          ? [sql`
          INSERT INTO provider_connections (
            business_id,
            provider,
            status,
            provider_account_ref_id,
            provider_account_id,
            provider_account_name,
            connected_at,
            disconnected_at,
            created_at,
            updated_at
          )
          SELECT
            i.business_id,
            i.provider,
            i.status,
            pa.id,
            NULLIF(i.provider_account_id, ''),
            NULLIF(i.provider_account_name, ''),
            i.connected_at,
            i.disconnected_at,
            i.created_at,
            i.updated_at
          FROM integrations i
          LEFT JOIN provider_accounts pa
            ON pa.provider = i.provider
           AND pa.external_account_id = NULLIF(i.provider_account_id, '')
          ON CONFLICT (business_id, provider) DO UPDATE SET
            status = EXCLUDED.status,
            provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, provider_connections.provider_account_ref_id),
            provider_account_id = COALESCE(EXCLUDED.provider_account_id, provider_connections.provider_account_id),
            provider_account_name = COALESCE(EXCLUDED.provider_account_name, provider_connections.provider_account_name),
            connected_at = COALESCE(provider_connections.connected_at, EXCLUDED.connected_at),
            disconnected_at = COALESCE(EXCLUDED.disconnected_at, provider_connections.disconnected_at),
            updated_at = EXCLUDED.updated_at
        `]
          : []),
        ...(legacyIntegrationsAvailable
          ? [sql`
          INSERT INTO integration_credentials (
            provider_connection_id,
            access_token,
            refresh_token,
            token_expires_at,
            scopes,
            error_message,
            metadata,
            created_at,
            updated_at
          )
          SELECT
            pc.id,
            i.access_token,
            i.refresh_token,
            i.token_expires_at,
            i.scopes,
            i.error_message,
            COALESCE(i.metadata, '{}'::jsonb),
            i.created_at,
            i.updated_at
          FROM integrations i
          JOIN provider_connections pc
            ON pc.business_id = i.business_id
           AND pc.provider = i.provider
          ON CONFLICT (provider_connection_id) DO UPDATE SET
            access_token = COALESCE(EXCLUDED.access_token, integration_credentials.access_token),
            refresh_token = COALESCE(EXCLUDED.refresh_token, integration_credentials.refresh_token),
            token_expires_at = COALESCE(EXCLUDED.token_expires_at, integration_credentials.token_expires_at),
            scopes = COALESCE(EXCLUDED.scopes, integration_credentials.scopes),
            error_message = COALESCE(EXCLUDED.error_message, integration_credentials.error_message),
            metadata = CASE
              WHEN EXCLUDED.metadata = '{}'::jsonb THEN integration_credentials.metadata
              ELSE integration_credentials.metadata || EXCLUDED.metadata
            END,
            updated_at = EXCLUDED.updated_at
        `]
          : []),
        ...(legacyAssignmentsAvailable
          ? [sql`
          INSERT INTO business_provider_accounts (
            business_id,
            provider,
            provider_account_ref_id,
            provider_account_id,
            position,
            created_at,
            updated_at
          )
          SELECT
            a.business_id,
            a.provider,
            pa.id,
            pa.external_account_id,
            ordinality - 1,
            a.created_at,
            a.updated_at
          FROM provider_account_assignments a
          CROSS JOIN LATERAL unnest(COALESCE(a.account_ids, ARRAY[]::TEXT[])) WITH ORDINALITY AS account(account_id, ordinality)
          JOIN provider_accounts pa
            ON pa.provider = a.provider
           AND pa.external_account_id = account.account_id
          ON CONFLICT (business_id, provider, provider_account_ref_id) DO UPDATE SET
            provider_account_id = EXCLUDED.provider_account_id,
            position = EXCLUDED.position,
            updated_at = EXCLUDED.updated_at
        `]
          : []),
        ...(legacySnapshotsAvailable
          ? [sql`
          INSERT INTO provider_account_snapshot_runs (
            business_id,
            provider,
            fetched_at,
            refresh_failed,
            last_error,
            refresh_requested_at,
            last_refresh_attempt_at,
            next_refresh_after,
            refresh_in_progress,
            accounts_hash,
            source_reason,
            last_successful_refresh_at,
            refresh_failure_streak,
            created_at,
            updated_at
          )
          SELECT
            business_id,
            provider,
            fetched_at,
            refresh_failed,
            last_error,
            refresh_requested_at,
            last_refresh_attempt_at,
            next_refresh_after,
            refresh_in_progress,
            accounts_hash,
            source_reason,
            last_successful_refresh_at,
            refresh_failure_streak,
            created_at,
            updated_at
          FROM provider_account_snapshots
          ON CONFLICT (business_id, provider) DO UPDATE SET
            fetched_at = EXCLUDED.fetched_at,
            refresh_failed = EXCLUDED.refresh_failed,
            last_error = EXCLUDED.last_error,
            refresh_requested_at = COALESCE(EXCLUDED.refresh_requested_at, provider_account_snapshot_runs.refresh_requested_at),
            last_refresh_attempt_at = COALESCE(EXCLUDED.last_refresh_attempt_at, provider_account_snapshot_runs.last_refresh_attempt_at),
            next_refresh_after = EXCLUDED.next_refresh_after,
            refresh_in_progress = EXCLUDED.refresh_in_progress,
            accounts_hash = EXCLUDED.accounts_hash,
            source_reason = EXCLUDED.source_reason,
            last_successful_refresh_at = COALESCE(EXCLUDED.last_successful_refresh_at, provider_account_snapshot_runs.last_successful_refresh_at),
            refresh_failure_streak = EXCLUDED.refresh_failure_streak,
            updated_at = EXCLUDED.updated_at
        `]
          : []),
        ...(legacySnapshotsAvailable
          ? [sql`
          INSERT INTO provider_account_snapshot_items (
            snapshot_run_id,
            provider_account_ref_id,
            provider_account_id,
            provider_account_name,
            currency,
            timezone,
            is_manager,
            position,
            raw_payload,
            created_at,
            updated_at
          )
          SELECT
            run.id,
            pa.id,
            NULLIF(item->>'id', ''),
            COALESCE(NULLIF(item->>'name', ''), NULLIF(item->>'id', '')),
            NULLIF(item->>'currency', ''),
            NULLIF(item->>'timezone', ''),
            CASE
              WHEN item ? 'isManager' THEN (item->>'isManager')::BOOLEAN
              ELSE NULL
            END,
            ordinality - 1,
            item,
            now(),
            now()
          FROM provider_account_snapshots s
          JOIN provider_account_snapshot_runs run
            ON run.business_id = s.business_id
           AND run.provider = s.provider
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.accounts_payload, '[]'::jsonb)) WITH ORDINALITY AS item(item, ordinality)
          LEFT JOIN provider_accounts pa
            ON pa.provider = s.provider
           AND pa.external_account_id = NULLIF(item.item->>'id', '')
          WHERE NULLIF(item.item->>'id', '') IS NOT NULL
          ON CONFLICT (snapshot_run_id, provider_account_id) DO UPDATE SET
            provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, provider_account_snapshot_items.provider_account_ref_id),
            provider_account_name = COALESCE(EXCLUDED.provider_account_name, provider_account_snapshot_items.provider_account_name),
            currency = COALESCE(EXCLUDED.currency, provider_account_snapshot_items.currency),
            timezone = COALESCE(EXCLUDED.timezone, provider_account_snapshot_items.timezone),
            is_manager = COALESCE(EXCLUDED.is_manager, provider_account_snapshot_items.is_manager),
            position = EXCLUDED.position,
            raw_payload = EXCLUDED.raw_payload,
            updated_at = EXCLUDED.updated_at
        `]
          : []),
      ]);

      // ── PHASE 3: Tables that depend on users+businesses ───────────────────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS memberships (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          role        TEXT NOT NULL CHECK (role IN ('admin', 'collaborator', 'guest')),
          status      TEXT NOT NULL CHECK (status IN ('active', 'invited', 'pending')),
          joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, business_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS invites (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email              TEXT NOT NULL,
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          role               TEXT NOT NULL CHECK (role IN ('admin', 'collaborator', 'guest')),
          token              TEXT NOT NULL UNIQUE,
          status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
          invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          expires_at         TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
          accepted_at        TIMESTAMPTZ,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS sessions (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash         TEXT NOT NULL UNIQUE,
          active_business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
          expires_at         TIMESTAMPTZ NOT NULL,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_cost_models (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          cogs_percent       DOUBLE PRECISION NOT NULL DEFAULT 0,
          shipping_percent   DOUBLE PRECISION NOT NULL DEFAULT 0,
          fee_percent        DOUBLE PRECISION NOT NULL DEFAULT 0,
          fixed_monthly_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
          fixed_cost         DOUBLE PRECISION NOT NULL DEFAULT 0,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_target_packs (
          id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          target_cpa                     DOUBLE PRECISION,
          target_roas                    DOUBLE PRECISION,
          break_even_cpa                 DOUBLE PRECISION,
          break_even_roas                DOUBLE PRECISION,
          contribution_margin_assumption DOUBLE PRECISION,
          aov_assumption                 DOUBLE PRECISION,
          new_customer_weight            DOUBLE PRECISION,
          default_risk_posture           TEXT NOT NULL DEFAULT 'balanced'
                                          CHECK (default_risk_posture IN ('conservative', 'balanced', 'aggressive')),
          cost_cogs_percent              DOUBLE PRECISION,
          cost_shipping_percent          DOUBLE PRECISION,
          cost_fulfillment_percent       DOUBLE PRECISION,
          cost_payment_processing_percent DOUBLE PRECISION,
          source_label                   TEXT,
          updated_by_user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_country_economics (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          country_code         TEXT NOT NULL,
          economics_multiplier DOUBLE PRECISION,
          margin_modifier      DOUBLE PRECISION,
          serviceability       TEXT NOT NULL DEFAULT 'full'
                                CHECK (serviceability IN ('full', 'limited', 'blocked')),
          priority_tier        TEXT NOT NULL DEFAULT 'tier_2'
                                CHECK (priority_tier IN ('tier_1', 'tier_2', 'tier_3')),
          scale_override       TEXT NOT NULL DEFAULT 'default'
                                CHECK (scale_override IN ('default', 'prefer_scale', 'hold', 'deprioritize')),
          notes                TEXT,
          source_label         TEXT,
          updated_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, country_code)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_promo_calendar_events (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          event_id           TEXT NOT NULL,
          title              TEXT NOT NULL,
          promo_type         TEXT NOT NULL DEFAULT 'sale'
                              CHECK (promo_type IN ('sale', 'launch', 'clearance', 'seasonal', 'other')),
          severity           TEXT NOT NULL DEFAULT 'medium'
                              CHECK (severity IN ('low', 'medium', 'high')),
          start_date         DATE NOT NULL,
          end_date           DATE NOT NULL,
          affected_scope     TEXT,
          notes              TEXT,
          source_label       TEXT,
          updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, event_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_operating_constraints (
          id                                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          site_issue_status                    TEXT NOT NULL DEFAULT 'none'
                                                CHECK (site_issue_status IN ('none', 'watch', 'critical')),
          checkout_issue_status                TEXT NOT NULL DEFAULT 'none'
                                                CHECK (checkout_issue_status IN ('none', 'watch', 'critical')),
          conversion_tracking_issue_status     TEXT NOT NULL DEFAULT 'none'
                                                CHECK (conversion_tracking_issue_status IN ('none', 'watch', 'critical')),
          feed_issue_status                    TEXT NOT NULL DEFAULT 'none'
                                                CHECK (feed_issue_status IN ('none', 'watch', 'critical')),
          stock_pressure_status                TEXT NOT NULL DEFAULT 'healthy'
                                                CHECK (stock_pressure_status IN ('healthy', 'watch', 'blocked')),
          landing_page_concern                 TEXT,
          merchandising_concern                TEXT,
          manual_do_not_scale_reason           TEXT,
          source_label                         TEXT,
          updated_by_user_id                   UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_decision_calibration_profiles (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          channel                    TEXT NOT NULL
                                       CHECK (channel IN ('meta', 'creative', 'command_center')),
          objective_family           TEXT NOT NULL
                                       CHECK (objective_family IN ('sales', 'catalog', 'leads', 'traffic', 'awareness', 'engagement', 'unknown')),
          bid_regime                 TEXT NOT NULL
                                       CHECK (bid_regime IN ('open', 'cost_cap', 'bid_cap', 'roas_floor', 'unknown')),
          archetype                  TEXT NOT NULL,
          target_roas_multiplier     DOUBLE PRECISION,
          break_even_roas_multiplier DOUBLE PRECISION,
          target_cpa_multiplier      DOUBLE PRECISION,
          break_even_cpa_multiplier  DOUBLE PRECISION,
          confidence_cap             DOUBLE PRECISION,
          action_ceiling             TEXT
                                       CHECK (action_ceiling IN ('review_hold', 'review_reduce', 'monitor_low_truth', 'degraded_no_scale')),
          engine_preset_label        TEXT NOT NULL DEFAULT 'balanced'
                                       CHECK (engine_preset_label IN ('aggressive', 'balanced', 'conservative')),
          zero_conv_burner_multiplier DOUBLE PRECISION,
          cut_candidate_multiplier   DOUBLE PRECISION,
          sustained_loser_multiplier DOUBLE PRECISION,
          hard_cut_multiplier        DOUBLE PRECISION,
          scale_evidence_multiplier  DOUBLE PRECISION,
          scale_purchase_multiplier  DOUBLE PRECISION,
          winner_memory_multiplier   DOUBLE PRECISION,
          recent_sample_multiplier   DOUBLE PRECISION,
          weak_funnel_rate_multiplier DOUBLE PRECISION,
          attribution_aov_adjustment_multiplier DOUBLE PRECISION,
          notes                      TEXT,
          source_label               TEXT,
          updated_by_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, channel, objective_family, bid_regime, archetype)
        )`,
        sql`CREATE TABLE IF NOT EXISTS admin_audit_logs (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          admin_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          action      TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id   TEXT,
          meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS discount_codes (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          code        TEXT NOT NULL UNIQUE,
          description TEXT,
          type        TEXT NOT NULL CHECK (type IN ('percent', 'fixed')),
          value       NUMERIC(10,2) NOT NULL,
          max_uses    INTEGER,
          uses        INTEGER NOT NULL DEFAULT 0,
          applies_to  TEXT[] NOT NULL DEFAULT '{}',
          valid_from  TIMESTAMPTZ,
          valid_until TIMESTAMPTZ,
          is_active   BOOLEAN NOT NULL DEFAULT true,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by  UUID REFERENCES users(id) ON DELETE SET NULL
        )`,
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_demo_business BOOLEAN NOT NULL DEFAULT FALSE`,
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS industry TEXT`,
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS platform TEXT`,
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`,
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan_override TEXT`,
        ...(legacySnapshotsAvailable
          ? [
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS refresh_requested_at TIMESTAMPTZ`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS last_refresh_attempt_at TIMESTAMPTZ`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS next_refresh_after TIMESTAMPTZ`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS refresh_in_progress BOOLEAN NOT NULL DEFAULT FALSE`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS accounts_hash TEXT`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS source_reason TEXT`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS last_successful_refresh_at TIMESTAMPTZ`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS refresh_failure_streak INTEGER NOT NULL DEFAULT 0`,
            ]
          : []),
        sql`ALTER TABLE shopify_subscriptions ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL`,
        sql`ALTER TABLE shopify_subscriptions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL`,
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_check_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_check_window_days INTEGER`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_verdict TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_metric TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_delta NUMERIC(18, 4)`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_verdict_fail_reason TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_confidence TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS execution_status TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS execution_error TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS rollback_available BOOLEAN`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS rollback_executed_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS completion_mode TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS completed_step_count INTEGER`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS total_step_count INTEGER`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS completed_step_ids JSONB`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS skipped_step_ids JSONB`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS core_step_ids JSONB`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS execution_metadata JSONB`.catch(() => {}),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS applied_snapshot JSONB`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_advisor_execution_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          recommendation_fingerprint TEXT NOT NULL,
          mutate_action_type TEXT NOT NULL,
          operation TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json JSONB,
          response_json JSONB,
          error_message TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS command_center_action_state (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          action_fingerprint  TEXT NOT NULL,
          source_system       TEXT NOT NULL CHECK (source_system IN ('meta', 'creative')),
          source_type         TEXT NOT NULL,
          action_title        TEXT NOT NULL,
          recommended_action  TEXT NOT NULL,
          workflow_status     TEXT NOT NULL DEFAULT 'pending'
                                CHECK (workflow_status IN ('pending', 'approved', 'rejected', 'snoozed', 'completed_manual', 'executed', 'failed', 'canceled')),
          assignee_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
          snooze_until        TIMESTAMPTZ,
          latest_note_excerpt TEXT,
          note_count          INTEGER NOT NULL DEFAULT 0,
          last_mutation_id    TEXT,
          last_mutated_at     TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, action_fingerprint)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_state_business_status
          ON command_center_action_state (business_id, workflow_status, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_state_business_assignee
          ON command_center_action_state (business_id, assignee_user_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS command_center_action_journal (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          action_fingerprint TEXT NOT NULL,
          action_title       TEXT NOT NULL,
          source_system      TEXT NOT NULL CHECK (source_system IN ('meta', 'creative')),
          source_type        TEXT NOT NULL,
          event_type         TEXT NOT NULL
                              CHECK (event_type IN ('status_changed', 'assignee_changed', 'note_added', 'handoff_created', 'handoff_acknowledged')),
          actor_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          client_mutation_id TEXT NOT NULL,
          message            TEXT NOT NULL,
          note               TEXT,
          metadata_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, client_mutation_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_journal_business_action
          ON command_center_action_journal (business_id, action_fingerprint, created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_journal_business_created
          ON command_center_action_journal (business_id, created_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS command_center_mutation_receipts (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          client_mutation_id TEXT NOT NULL,
          mutation_scope     TEXT NOT NULL,
          payload_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, client_mutation_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_mutation_receipts_business_created
          ON command_center_mutation_receipts (business_id, created_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS command_center_saved_views (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          view_key        TEXT NOT NULL,
          name            TEXT NOT NULL,
          definition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, view_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_saved_views_business
          ON command_center_saved_views (business_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS command_center_handoffs (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          shift                      TEXT NOT NULL CHECK (shift IN ('morning', 'evening')),
          summary                    TEXT NOT NULL,
          blockers_json              JSONB NOT NULL DEFAULT '[]'::jsonb,
          watchouts_json             JSONB NOT NULL DEFAULT '[]'::jsonb,
          linked_action_fingerprints TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          from_user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          to_user_id                 UUID REFERENCES users(id) ON DELETE SET NULL,
          acknowledged_at            TIMESTAMPTZ,
          acknowledged_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_handoffs_business_shift
          ON command_center_handoffs (business_id, shift, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS command_center_feedback (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          client_mutation_id TEXT NOT NULL,
          feedback_type      TEXT NOT NULL
                              CHECK (feedback_type IN ('false_positive', 'bad_recommendation', 'false_negative')),
          outcome            TEXT NOT NULL DEFAULT 'operator_note'
                              CHECK (outcome IN ('calibration_candidate', 'workflow_gap', 'operator_note')),
          scope              TEXT NOT NULL CHECK (scope IN ('action', 'queue_gap')),
          action_fingerprint TEXT,
          action_title       TEXT,
          source_system      TEXT CHECK (source_system IN ('meta', 'creative')),
          source_type        TEXT,
          workload_class     TEXT
                              CHECK (workload_class IN ('budget_shift', 'scale_promotion', 'recovery', 'creative_refresh', 'test_backlog', 'geo_review', 'risk_triage', 'policy_guardrail', 'protected_watch', 'archive_context')),
          calibration_hint_json JSONB NOT NULL DEFAULT 'null'::jsonb,
          view_key           TEXT,
          note               TEXT NOT NULL,
          actor_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, client_mutation_id)
        )`.catch(() => {}),
        sql`ALTER TABLE command_center_feedback
          ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'operator_note'
            CHECK (outcome IN ('calibration_candidate', 'workflow_gap', 'operator_note'))`.catch(() => {}),
        sql`ALTER TABLE command_center_feedback
          ADD COLUMN IF NOT EXISTS workload_class TEXT
            CHECK (workload_class IN ('budget_shift', 'scale_promotion', 'recovery', 'creative_refresh', 'test_backlog', 'geo_review', 'risk_triage', 'policy_guardrail', 'protected_watch', 'archive_context'))`.catch(() => {}),
        sql`ALTER TABLE command_center_feedback
          ADD COLUMN IF NOT EXISTS calibration_hint_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_feedback_business_created
          ON command_center_feedback (business_id, created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_feedback_business_action
          ON command_center_feedback (business_id, action_fingerprint, created_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS command_center_action_execution_state (
          id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          action_fingerprint           TEXT NOT NULL,
          execution_status             TEXT NOT NULL
                                        CHECK (execution_status IN ('draft', 'ready_for_apply', 'applying', 'executed', 'failed', 'rolled_back', 'manual_only', 'unsupported')),
          support_mode                 TEXT NOT NULL
                                        CHECK (support_mode IN ('supported', 'manual_only', 'unsupported')),
          source_system                TEXT NOT NULL CHECK (source_system IN ('meta', 'creative')),
          source_type                  TEXT NOT NULL,
          requested_action             TEXT NOT NULL,
          preview_hash                 TEXT,
          capability_key               TEXT,
          workflow_status_snapshot     TEXT NOT NULL DEFAULT 'pending'
                                        CHECK (workflow_status_snapshot IN ('pending', 'approved', 'rejected', 'snoozed', 'completed_manual', 'executed', 'failed', 'canceled')),
          approval_actor_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
          approval_actor_name          TEXT,
          approval_actor_email         TEXT,
          approved_at                  TIMESTAMPTZ,
          applied_by_user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
          applied_by_name              TEXT,
          applied_by_email             TEXT,
          applied_at                   TIMESTAMPTZ,
          rollback_kind                TEXT NOT NULL DEFAULT 'not_available'
                                        CHECK (rollback_kind IN ('provider_rollback', 'recovery_note_only', 'not_available')),
          rollback_note                TEXT,
          last_client_mutation_id      TEXT,
          last_error_code              TEXT,
          last_error_message           TEXT,
          current_state_json           JSONB NOT NULL DEFAULT 'null'::jsonb,
          requested_state_json         JSONB NOT NULL DEFAULT 'null'::jsonb,
          captured_pre_apply_state_json JSONB NOT NULL DEFAULT 'null'::jsonb,
          preflight_json               JSONB NOT NULL DEFAULT 'null'::jsonb,
          validation_json              JSONB NOT NULL DEFAULT 'null'::jsonb,
          provider_diff_json           JSONB NOT NULL DEFAULT 'null'::jsonb,
          provider_response_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, action_fingerprint)
        )`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_state
          ADD COLUMN IF NOT EXISTS capability_key TEXT`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_state
          ADD COLUMN IF NOT EXISTS preflight_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_state
          ADD COLUMN IF NOT EXISTS validation_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_state
          ADD COLUMN IF NOT EXISTS provider_diff_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_execution_state_business_status
          ON command_center_action_execution_state (business_id, execution_status, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS command_center_action_execution_audit (
          id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          action_fingerprint           TEXT NOT NULL,
          client_mutation_id           TEXT NOT NULL,
          operation                    TEXT NOT NULL CHECK (operation IN ('apply', 'rollback')),
          execution_status             TEXT NOT NULL
                                        CHECK (execution_status IN ('draft', 'ready_for_apply', 'applying', 'executed', 'failed', 'rolled_back', 'manual_only', 'unsupported')),
          support_mode                 TEXT NOT NULL
                                        CHECK (support_mode IN ('supported', 'manual_only', 'unsupported')),
          actor_user_id                UUID REFERENCES users(id) ON DELETE SET NULL,
          actor_name                   TEXT,
          actor_email                  TEXT,
          approval_actor_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
          approval_actor_name          TEXT,
          approval_actor_email         TEXT,
          approved_at                  TIMESTAMPTZ,
          preview_hash                 TEXT,
          capability_key               TEXT,
          rollback_kind                TEXT NOT NULL DEFAULT 'not_available'
                                        CHECK (rollback_kind IN ('provider_rollback', 'recovery_note_only', 'not_available')),
          rollback_note                TEXT,
          current_state_json           JSONB NOT NULL DEFAULT 'null'::jsonb,
          requested_state_json         JSONB NOT NULL DEFAULT 'null'::jsonb,
          captured_pre_apply_state_json JSONB NOT NULL DEFAULT 'null'::jsonb,
          preflight_json               JSONB NOT NULL DEFAULT 'null'::jsonb,
          validation_json              JSONB NOT NULL DEFAULT 'null'::jsonb,
          provider_diff_json           JSONB NOT NULL DEFAULT 'null'::jsonb,
          provider_response_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
          failure_reason               TEXT,
          external_refs_json           JSONB NOT NULL DEFAULT 'null'::jsonb,
          created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, client_mutation_id)
        )`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_audit
          ADD COLUMN IF NOT EXISTS capability_key TEXT`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_audit
          ADD COLUMN IF NOT EXISTS preflight_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_audit
          ADD COLUMN IF NOT EXISTS validation_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_audit
          ADD COLUMN IF NOT EXISTS provider_diff_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_execution_audit_business_action
          ON command_center_action_execution_audit (business_id, action_fingerprint, created_at DESC)`.catch(() => {}),
      ]);

      // ── PHASE 4: Tables with deeper deps + all remaining indexes ──────────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS discount_redemptions (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          code_id     UUID NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
          user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
          plan_id     TEXT NOT NULL,
          amount_off  NUMERIC(10,2) NOT NULL,
          redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS shopify_install_contexts (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          token                 TEXT NOT NULL UNIQUE,
          shop_domain           TEXT NOT NULL,
          shop_name             TEXT,
          access_token          TEXT NOT NULL,
          scopes                TEXT,
          metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
          return_to             TEXT,
          session_id            UUID REFERENCES sessions(id) ON DELETE SET NULL,
          user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
          preferred_business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at            TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes')
        )`,
        sql`ALTER TABLE invites ADD COLUMN IF NOT EXISTS invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`,
        sql`ALTER TABLE invites ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')`,
        sql`ALTER TABLE invites ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ`,
        sql`ALTER TABLE invites ADD COLUMN IF NOT EXISTS workspace_ids UUID[]`,
        sql`ALTER TABLE business_cost_models ADD COLUMN IF NOT EXISTS fixed_monthly_cost DOUBLE PRECISION NOT NULL DEFAULT 0`,
        sql`ALTER TABLE business_cost_models ADD COLUMN IF NOT EXISTS fixed_cost DOUBLE PRECISION NOT NULL DEFAULT 0`,
        sql`ALTER TABLE business_target_packs ADD COLUMN IF NOT EXISTS cost_cogs_percent DOUBLE PRECISION`,
        sql`ALTER TABLE business_target_packs ADD COLUMN IF NOT EXISTS cost_shipping_percent DOUBLE PRECISION`,
        sql`ALTER TABLE business_target_packs ADD COLUMN IF NOT EXISTS cost_fulfillment_percent DOUBLE PRECISION`,
        sql`ALTER TABLE business_target_packs ADD COLUMN IF NOT EXISTS cost_payment_processing_percent DOUBLE PRECISION`,
        sql`ALTER TABLE business_decision_calibration_profiles
          ADD COLUMN IF NOT EXISTS engine_preset_label TEXT NOT NULL DEFAULT 'balanced'
            CHECK (engine_preset_label IN ('aggressive', 'balanced', 'conservative')),
          ADD COLUMN IF NOT EXISTS zero_conv_burner_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS cut_candidate_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS sustained_loser_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS hard_cut_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS scale_evidence_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS scale_purchase_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS winner_memory_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS recent_sample_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS weak_funnel_rate_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS attribution_aov_adjustment_multiplier DOUBLE PRECISION`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_invites_business_id ON invites (business_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_invites_email ON invites (email)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_business_cost_models_business_id ON business_cost_models (business_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_business_target_packs_business_id ON business_target_packs (business_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_business_country_economics_business_country ON business_country_economics (business_id, country_code)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_business_promo_calendar_events_business_event ON business_promo_calendar_events (business_id, event_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_business_promo_calendar_events_business_dates ON business_promo_calendar_events (business_id, start_date, end_date)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_business_operating_constraints_business_id ON business_operating_constraints (business_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_business_decision_calibration_profiles_business ON business_decision_calibration_profiles (business_id, channel)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_business_decision_calibration_profiles_profile ON business_decision_calibration_profiles (business_id, objective_family, bid_regime, archetype)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin ON admin_audit_logs (admin_id, created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created ON admin_audit_logs (created_at DESC)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_codes_code ON discount_codes (lower(code))`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_subscriptions_business_id ON shopify_subscriptions (business_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_subscriptions_user_id ON shopify_subscriptions (user_id)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_shopify_install_contexts_token ON shopify_install_contexts (token)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_install_contexts_expires_at ON shopify_install_contexts (expires_at)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_install_contexts_user_id ON shopify_install_contexts (user_id)`.catch(() => {}),
      ]);

      // Phase 4b: discount_redemptions indexes (after table created above)
      await runMigrationBatchSequentially([
        sql`CREATE INDEX IF NOT EXISTS idx_discount_redemptions_code ON discount_redemptions (code_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_discount_redemptions_user ON discount_redemptions (user_id)`.catch(() => {}),
        sql`UPDATE business_cost_models SET fixed_monthly_cost = fixed_cost WHERE fixed_monthly_cost = 0 AND fixed_cost <> 0`,
        sql`UPDATE business_cost_models SET fixed_cost = fixed_monthly_cost WHERE fixed_cost = 0 AND fixed_monthly_cost <> 0`,
        sql`CREATE TABLE IF NOT EXISTS seo_results_cache (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id  TEXT NOT NULL,
          cache_type   TEXT NOT NULL CHECK (cache_type IN ('overview', 'findings')),
          start_date   DATE NOT NULL,
          end_date     DATE NOT NULL,
          payload      JSONB NOT NULL,
          generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_seo_results_cache_lookup ON seo_results_cache (business_id, cache_type, start_date, end_date)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_seo_results_cache_business ON seo_results_cache (business_id, generated_at DESC)`.catch(() => {}),
        // ── Google integration: quota & sync tables ──────────────────────────
        sql`CREATE TABLE IF NOT EXISTS provider_cooldown_state (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id   TEXT NOT NULL,
          provider      TEXT NOT NULL,
          request_type  TEXT NOT NULL,
          failed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          failure_count INT NOT NULL DEFAULT 1,
          error_message TEXT,
          http_status   INT,
          cooldown_until TIMESTAMPTZ NOT NULL,
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_cooldown_state_key ON provider_cooldown_state (business_id, provider, request_type)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_cooldown_state_until ON provider_cooldown_state (cooldown_until)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS provider_sync_jobs (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id    TEXT NOT NULL,
          provider       TEXT NOT NULL,
          report_type    TEXT NOT NULL,
          date_range_key TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'pending',
          triggered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at     TIMESTAMPTZ,
          lock_owner     TEXT,
          lock_expires_at TIMESTAMPTZ,
          completed_at   TIMESTAMPTZ,
          error_message  TEXT
        )`.catch(() => {}),
        sql`ALTER TABLE provider_sync_jobs ADD COLUMN IF NOT EXISTS lock_owner TEXT`.catch(() => {}),
        sql`ALTER TABLE provider_sync_jobs ADD COLUMN IF NOT EXISTS lock_expires_at TIMESTAMPTZ`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_sync_jobs_key ON provider_sync_jobs (business_id, provider, report_type, date_range_key)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_sync_jobs_status ON provider_sync_jobs (status, triggered_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_sync_jobs_lock_expiry ON provider_sync_jobs (lock_expires_at)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS provider_quota_usage (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id    TEXT NOT NULL,
          provider       TEXT NOT NULL,
          quota_date     DATE NOT NULL DEFAULT CURRENT_DATE,
          call_count     INT NOT NULL DEFAULT 0,
          error_count    INT NOT NULL DEFAULT 0,
          last_called_at TIMESTAMPTZ
        )`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_quota_usage_key ON provider_quota_usage (business_id, provider, quota_date)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS provider_request_audit_daily (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider                TEXT NOT NULL,
          audit_date              DATE NOT NULL DEFAULT CURRENT_DATE,
          request_type            TEXT NOT NULL,
          audit_source            TEXT NOT NULL DEFAULT 'unknown',
          audit_path              TEXT NOT NULL DEFAULT '',
          request_count           INT NOT NULL DEFAULT 0,
          error_count             INT NOT NULL DEFAULT 0,
          quota_error_count       INT NOT NULL DEFAULT 0,
          auth_error_count        INT NOT NULL DEFAULT 0,
          permission_error_count  INT NOT NULL DEFAULT 0,
          generic_error_count     INT NOT NULL DEFAULT 0,
          cooldown_hit_count      INT NOT NULL DEFAULT 0,
          deduped_count           INT NOT NULL DEFAULT 0,
          last_error_at           TIMESTAMPTZ,
          last_error_message      TEXT,
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_request_audit_daily_key
          ON provider_request_audit_daily (
            business_id,
            provider,
            audit_date,
            request_type,
            audit_source,
            audit_path
          )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_request_audit_daily_provider
          ON provider_request_audit_daily (provider, audit_date, updated_at DESC)`.catch(() => {}),
        // ── Meta warehouse-first pilot tables ───────────────────────────────
        sql`CREATE TABLE IF NOT EXISTS meta_sync_jobs (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          sync_type           TEXT NOT NULL
                              CHECK (sync_type IN ('initial_backfill', 'incremental_recent', 'today_refresh', 'repair_window', 'reconnect_backfill')),
          scope               TEXT NOT NULL DEFAULT 'account_daily',
          start_date          DATE NOT NULL,
          end_date            DATE NOT NULL,
          status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
          progress_percent    DOUBLE PRECISION NOT NULL DEFAULT 0,
          trigger_source      TEXT NOT NULL DEFAULT 'system',
          retry_count         INTEGER NOT NULL DEFAULT 0,
          last_error          TEXT,
          triggered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_jobs_business ON meta_sync_jobs (business_id, triggered_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_jobs_account ON meta_sync_jobs (provider_account_id, triggered_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_jobs_status ON meta_sync_jobs (status, triggered_at DESC)`.catch(() => {}),
        sql`
          WITH ranked AS (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY business_id, provider_account_id, sync_type, scope, start_date, end_date, trigger_source
                ORDER BY updated_at DESC, triggered_at DESC, id DESC
              ) AS row_number
            FROM meta_sync_jobs
            WHERE status = 'running'
          )
          UPDATE meta_sync_jobs job
          SET
            status = 'failed',
            last_error = COALESCE(job.last_error, 'duplicate running sync job cleaned up during migration'),
            finished_at = now(),
            updated_at = now()
          FROM ranked
          WHERE job.id = ranked.id
            AND ranked.row_number > 1
        `.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_sync_jobs_running_unique
          ON meta_sync_jobs (
            business_id,
            provider_account_id,
            sync_type,
            scope,
            start_date,
            end_date,
            trigger_source
          )
          WHERE status = 'running'`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_sync_partitions (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          lane                TEXT NOT NULL CHECK (lane IN ('core', 'extended', 'maintenance')),
          scope               TEXT NOT NULL,
          partition_date      DATE NOT NULL,
          status              TEXT NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
          priority            INTEGER NOT NULL DEFAULT 0,
          source              TEXT NOT NULL DEFAULT 'system',
          lease_owner         TEXT,
          lease_expires_at    TIMESTAMPTZ,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          next_retry_at       TIMESTAMPTZ,
          last_error          TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, lane, scope, partition_date)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_partitions_queue
          ON meta_sync_partitions (business_id, lane, status, priority DESC, partition_date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_partitions_lease
          ON meta_sync_partitions (status, lease_expires_at, next_retry_at, updated_at DESC)`.catch(() => {}),
        sql`ALTER TABLE meta_sync_partitions ADD COLUMN IF NOT EXISTS lease_epoch BIGINT NOT NULL DEFAULT 0`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_sync_runs (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          partition_id        UUID REFERENCES meta_sync_partitions(id) ON DELETE CASCADE,
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          lane                TEXT NOT NULL CHECK (lane IN ('core', 'extended', 'maintenance')),
          scope               TEXT NOT NULL,
          partition_date      DATE NOT NULL,
          status              TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
          worker_id           TEXT,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          row_count           INTEGER,
          duration_ms         INTEGER,
          error_class         TEXT,
          error_message       TEXT,
          meta_json           JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_runs_partition ON meta_sync_runs (partition_id, created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_runs_business ON meta_sync_runs (business_id, created_at DESC)`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_sync_runs_one_running_per_partition
          ON meta_sync_runs (partition_id)
          WHERE status = 'running'`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_sync_checkpoints (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          partition_id              UUID NOT NULL REFERENCES meta_sync_partitions(id) ON DELETE CASCADE,
          business_id               TEXT NOT NULL,
          provider_account_id       TEXT NOT NULL,
          checkpoint_scope          TEXT NOT NULL,
          phase                     TEXT NOT NULL
                                    CHECK (phase IN ('fetch_raw', 'transform', 'bulk_upsert', 'finalize')),
          status                    TEXT NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
          page_index                INTEGER NOT NULL DEFAULT 0,
          next_page_url             TEXT,
          provider_cursor           TEXT,
          rows_fetched              INTEGER NOT NULL DEFAULT 0,
          rows_written              INTEGER NOT NULL DEFAULT 0,
          last_successful_entity_key TEXT,
          last_response_headers     JSONB NOT NULL DEFAULT '{}'::jsonb,
          checkpoint_hash           TEXT,
          attempt_count             INTEGER NOT NULL DEFAULT 0,
          retry_after_at            TIMESTAMPTZ,
          lease_owner               TEXT,
          lease_expires_at          TIMESTAMPTZ,
          started_at                TIMESTAMPTZ,
          finished_at               TIMESTAMPTZ,
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (partition_id, checkpoint_scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_checkpoints_partition
          ON meta_sync_checkpoints (partition_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_checkpoints_scope
          ON meta_sync_checkpoints (business_id, provider_account_id, checkpoint_scope, status, updated_at DESC)`.catch(() => {}),
        sql`ALTER TABLE meta_sync_checkpoints ADD COLUMN IF NOT EXISTS lease_epoch BIGINT`.catch(() => {}),
        sql`ALTER TABLE meta_sync_checkpoints ADD COLUMN IF NOT EXISTS run_id TEXT`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_checkpoints_partition_epoch
          ON meta_sync_checkpoints (partition_id, lease_epoch, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_checkpoints_partition_run
          ON meta_sync_checkpoints (partition_id, checkpoint_scope, run_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_sync_phase_timings (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          partition_id        UUID NOT NULL REFERENCES meta_sync_partitions(id) ON DELETE CASCADE,
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          timing_scope        TEXT NOT NULL,
          run_id              TEXT,
          phase               TEXT NOT NULL
                              CHECK (phase IN ('fetch_raw', 'transform', 'bulk_upsert', 'finalize', 'publish')),
          status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
          rows_fetched        INTEGER NOT NULL DEFAULT 0,
          rows_written        INTEGER NOT NULL DEFAULT 0,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          lease_epoch         BIGINT,
          lease_owner         TEXT,
          lease_expires_at    TIMESTAMPTZ,
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (partition_id, timing_scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_phase_timings_partition
          ON meta_sync_phase_timings (partition_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_phase_timings_business
          ON meta_sync_phase_timings (business_id, provider_account_id, phase, status, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS sync_worker_heartbeats (
          worker_id          TEXT PRIMARY KEY,
          instance_type      TEXT NOT NULL,
          provider_scope     TEXT NOT NULL,
          status             TEXT NOT NULL DEFAULT 'starting'
                             CHECK (status IN ('starting', 'idle', 'running', 'stopping', 'stopped')),
          last_heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_business_id   TEXT,
          last_partition_id  TEXT,
          meta_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_worker_heartbeats_status
          ON sync_worker_heartbeats (status, last_heartbeat_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_worker_heartbeats_last_heartbeat
          ON sync_worker_heartbeats (last_heartbeat_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS sync_reclaim_events (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider_scope    TEXT NOT NULL,
          business_id       TEXT NOT NULL,
          partition_id      TEXT,
          checkpoint_scope  TEXT,
          event_type        TEXT NOT NULL
                           CHECK (event_type IN ('reclaimed', 'poisoned')),
          disposition       TEXT,
          reason_code       TEXT,
          detail            TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`ALTER TABLE sync_reclaim_events ADD COLUMN IF NOT EXISTS disposition TEXT`.catch(() => {}),
        sql`ALTER TABLE sync_reclaim_events ADD COLUMN IF NOT EXISTS reason_code TEXT`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_reclaim_events_provider
          ON sync_reclaim_events (provider_scope, business_id, created_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS sync_runner_leases (
          business_id        TEXT NOT NULL,
          provider_scope     TEXT NOT NULL,
          lease_owner        TEXT NOT NULL,
          lease_expires_at   TIMESTAMPTZ NOT NULL,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_runner_leases_expiry
          ON sync_runner_leases (provider_scope, lease_expires_at, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS sync_runtime_instances (
          instance_id         TEXT PRIMARY KEY,
          service             TEXT NOT NULL
                              CHECK (service IN ('web', 'worker')),
          runtime_role        TEXT NOT NULL
                              CHECK (runtime_role IN ('web', 'worker')),
          build_id            TEXT NOT NULL,
          db_fingerprint      TEXT NOT NULL,
          config_fingerprint  TEXT NOT NULL,
          provider_scopes     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          health_state        TEXT NOT NULL DEFAULT 'healthy'
                              CHECK (health_state IN ('healthy', 'invalid')),
          contract_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_runtime_instances_service_seen
          ON sync_runtime_instances (service, last_seen_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_runtime_instances_build
          ON sync_runtime_instances (build_id, service, last_seen_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS sync_release_gates (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          build_id          TEXT NOT NULL,
          environment       TEXT NOT NULL,
          gate_kind         TEXT NOT NULL
                            CHECK (gate_kind IN ('deploy_gate', 'release_gate')),
          gate_scope        TEXT NOT NULL DEFAULT 'release_readiness',
          mode              TEXT NOT NULL
                            CHECK (mode IN ('measure_only', 'warn_only', 'block')),
          base_result       TEXT NOT NULL
                            CHECK (base_result IN ('pass', 'fail', 'misconfigured')),
          verdict           TEXT NOT NULL
                            CHECK (verdict IN ('pass', 'fail', 'misconfigured', 'measure_only', 'warn_only', 'blocked')),
          blocker_class     TEXT,
          summary           TEXT NOT NULL,
          break_glass       BOOLEAN NOT NULL DEFAULT FALSE,
          override_reason   TEXT,
          evidence_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
          emitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (build_id, environment, gate_kind)
        )`.catch(() => {}),
        sql`ALTER TABLE sync_release_gates
          DROP CONSTRAINT IF EXISTS sync_release_gates_build_id_environment_gate_kind_key`.catch(() => {}),
        sql`ALTER TABLE sync_release_gates
          ADD COLUMN IF NOT EXISTS gate_scope TEXT NOT NULL DEFAULT 'release_readiness'`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_release_gates_build
          ON sync_release_gates (build_id, environment, gate_kind, emitted_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_release_gates_emitted
          ON sync_release_gates (emitted_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS sync_repair_plans (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          build_id            TEXT NOT NULL,
          environment         TEXT NOT NULL,
          provider_scope      TEXT NOT NULL,
          plan_mode           TEXT NOT NULL
                              CHECK (plan_mode IN ('dry_run', 'auto_execute', 'escalated_manual')),
          eligible            BOOLEAN NOT NULL DEFAULT FALSE,
          blocked_reason      TEXT,
          break_glass         BOOLEAN NOT NULL DEFAULT FALSE,
          summary             TEXT NOT NULL,
          payload_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
          emitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (build_id, environment, provider_scope, plan_mode)
        )`.catch(() => {}),
        sql`ALTER TABLE sync_repair_plans
          DROP CONSTRAINT IF EXISTS sync_repair_plans_build_id_environment_provider_scope_plan_mode_key`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_repair_plans_build
          ON sync_repair_plans (build_id, environment, provider_scope, emitted_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_repair_plans_provider_latest
          ON sync_repair_plans (provider_scope, emitted_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS sync_repair_executions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          build_id                TEXT NOT NULL,
          environment             TEXT NOT NULL,
          provider_scope          TEXT NOT NULL,
          business_id             TEXT NOT NULL,
          business_name           TEXT,
          source_release_gate_id  UUID,
          source_repair_plan_id   UUID,
          post_run_release_gate_id UUID,
          post_run_repair_plan_id  UUID,
          recommended_action      TEXT,
          executed_action         TEXT,
          workflow_run_id         TEXT,
          workflow_actor          TEXT,
          lock_owner              TEXT,
          execution_signature     TEXT,
          status                  TEXT NOT NULL
                                  CHECK (status IN ('queued', 'running', 'succeeded', 'completed', 'failed', 'exhausted', 'locked')),
          outcome_classification  TEXT
                                  CHECK (
                                    outcome_classification IS NULL OR
                                    outcome_classification IN (
                                      'cleared',
                                      'improving_not_cleared',
                                      'no_change',
                                      'worse',
                                      'manual_follow_up_required',
                                      'locked'
                                    )
                                  ),
          expected_outcome_met    BOOLEAN,
          before_evidence_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
          action_result_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
          after_evidence_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at             TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`ALTER TABLE sync_repair_executions
          ADD COLUMN IF NOT EXISTS post_run_release_gate_id UUID`.catch(() => {}),
        sql`ALTER TABLE sync_repair_executions
          ADD COLUMN IF NOT EXISTS post_run_repair_plan_id UUID`.catch(() => {}),
        sql`ALTER TABLE sync_repair_executions
          ADD COLUMN IF NOT EXISTS execution_signature TEXT`.catch(() => {}),
        sql`ALTER TABLE sync_repair_plans
          DROP CONSTRAINT IF EXISTS sync_repair_plans_plan_mode_check`.catch(() => {}),
        sql`ALTER TABLE sync_repair_plans
          ADD CONSTRAINT sync_repair_plans_plan_mode_check
          CHECK (plan_mode IN ('dry_run', 'auto_execute', 'escalated_manual'))`.catch(() => {}),
        sql`ALTER TABLE sync_repair_executions
          DROP CONSTRAINT IF EXISTS sync_repair_executions_status_check`.catch(() => {}),
        sql`ALTER TABLE sync_repair_executions
          ADD CONSTRAINT sync_repair_executions_status_check
          CHECK (status IN ('queued', 'running', 'succeeded', 'completed', 'failed', 'exhausted', 'locked'))`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_repair_executions_build
          ON sync_repair_executions (build_id, environment, provider_scope, started_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_repair_executions_business
          ON sync_repair_executions (business_id, provider_scope, started_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_repair_executions_signature
          ON sync_repair_executions (provider_scope, business_id, execution_signature, started_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS sync_incidents (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          build_id             TEXT NOT NULL,
          environment          TEXT NOT NULL,
          provider_scope       TEXT NOT NULL,
          business_id          TEXT NOT NULL,
          resource_scope       TEXT NOT NULL DEFAULT 'business',
          fault_class          TEXT NOT NULL,
          fault_signature      TEXT NOT NULL,
          status               TEXT NOT NULL
                               CHECK (
                                 status IN (
                                   'detected',
                                   'eligible',
                                   'repairing',
                                   'cooldown',
                                   'half_open',
                                   'cleared',
                                   'quarantined',
                                   'exhausted',
                                   'manual_required'
                                 )
                               ),
          blocker_class        TEXT,
          summary              TEXT NOT NULL,
          observation_count    INTEGER NOT NULL DEFAULT 1,
          first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          eligible_at          TIMESTAMPTZ,
          repairing_at         TIMESTAMPTZ,
          cooldown_until       TIMESTAMPTZ,
          half_open_at         TIMESTAMPTZ,
          cleared_at           TIMESTAMPTZ,
          quarantined_at       TIMESTAMPTZ,
          exhausted_at         TIMESTAMPTZ,
          manual_required_at   TIMESTAMPTZ,
          last_error           TEXT,
          evidence_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
          metadata_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (provider_scope, business_id, resource_scope, fault_class, fault_signature)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_incidents_active
          ON sync_incidents (build_id, environment, provider_scope, business_id, status, last_seen_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_incidents_fault
          ON sync_incidents (provider_scope, business_id, resource_scope, fault_class, fault_signature, last_seen_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_sync_state (
          business_id                   TEXT NOT NULL,
          provider_account_id           TEXT NOT NULL,
          scope                         TEXT NOT NULL,
          historical_target_start       DATE NOT NULL,
          historical_target_end         DATE NOT NULL,
          effective_target_start        DATE NOT NULL,
          effective_target_end          DATE NOT NULL,
          ready_through_date            DATE,
          last_successful_partition_date DATE,
          latest_background_activity_at TIMESTAMPTZ,
          latest_successful_sync_at     TIMESTAMPTZ,
          completed_days                INTEGER NOT NULL DEFAULT 0,
          dead_letter_count             INTEGER NOT NULL DEFAULT 0,
          updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_state_business
          ON meta_sync_state (business_id, scope, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_raw_snapshots (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          partition_id         UUID REFERENCES meta_sync_partitions(id) ON DELETE CASCADE,
          checkpoint_id        UUID REFERENCES meta_sync_checkpoints(id) ON DELETE SET NULL,
          endpoint_name        TEXT NOT NULL,
          entity_scope         TEXT NOT NULL DEFAULT 'account',
          page_index           INTEGER,
          provider_cursor      TEXT,
          start_date           DATE NOT NULL,
          end_date             DATE NOT NULL,
          account_timezone     TEXT,
          account_currency     TEXT,
          payload_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          payload_hash         TEXT NOT NULL,
          request_context      JSONB NOT NULL DEFAULT '{}'::jsonb,
          response_headers     JSONB NOT NULL DEFAULT '{}'::jsonb,
          provider_http_status INTEGER,
          status               TEXT NOT NULL DEFAULT 'fetched'
                               CHECK (status IN ('fetched', 'partial', 'failed')),
          fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`DO $$
          BEGIN
            IF EXISTS (
              SELECT 1
              FROM pg_constraint
              WHERE conrelid = 'meta_raw_snapshots'::regclass
                AND conname = 'meta_raw_snapshots_status_check'
                AND pg_get_constraintdef(oid) NOT ILIKE '%superseded%'
            ) THEN
              ALTER TABLE meta_raw_snapshots
                DROP CONSTRAINT meta_raw_snapshots_status_check;
              ALTER TABLE meta_raw_snapshots
                ADD CONSTRAINT meta_raw_snapshots_status_check
                CHECK (status IN ('fetched', 'partial', 'failed', 'superseded'));
            ELSIF NOT EXISTS (
              SELECT 1
              FROM pg_constraint
              WHERE conrelid = 'meta_raw_snapshots'::regclass
                AND conname = 'meta_raw_snapshots_status_check'
            ) THEN
              ALTER TABLE meta_raw_snapshots
                ADD CONSTRAINT meta_raw_snapshots_status_check
                CHECK (status IN ('fetched', 'partial', 'failed', 'superseded'));
            END IF;
          END $$`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_business ON meta_raw_snapshots (business_id, fetched_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_account ON meta_raw_snapshots (provider_account_id, fetched_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_window ON meta_raw_snapshots (business_id, provider_account_id, start_date, end_date)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_endpoint ON meta_raw_snapshots (endpoint_name, fetched_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_partition_endpoint
          ON meta_raw_snapshots (partition_id, endpoint_name, page_index)`.catch(() => {}),
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS partition_id UUID REFERENCES meta_sync_partitions(id) ON DELETE CASCADE`.catch(() => {}),
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS checkpoint_id UUID REFERENCES meta_sync_checkpoints(id) ON DELETE SET NULL`.catch(() => {}),
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS run_id TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS page_index INTEGER`.catch(() => {}),
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS provider_cursor TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS response_headers JSONB NOT NULL DEFAULT '{}'::jsonb`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_partition_run_endpoint
          ON meta_raw_snapshots (partition_id, run_id, endpoint_name, page_index)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_account_daily (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          date                 DATE NOT NULL,
          account_name         TEXT,
          account_timezone     TEXT NOT NULL,
          account_currency     TEXT NOT NULL,
          spend                DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions          BIGINT NOT NULL DEFAULT 0,
          clicks               BIGINT NOT NULL DEFAULT 0,
          reach                BIGINT NOT NULL DEFAULT 0,
          frequency            DOUBLE PRECISION,
          conversions          DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue              DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                 DOUBLE PRECISION NOT NULL DEFAULT 0,
          cpa                  DOUBLE PRECISION,
          ctr                  DOUBLE PRECISION,
          cpc                  DOUBLE PRECISION,
          source_snapshot_id   UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          metric_schema_version INTEGER NOT NULL DEFAULT 1,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_account_daily_business_date ON meta_account_daily (business_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_account_daily_account_date ON meta_account_daily (provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_account_daily_business_account_date
          ON meta_account_daily (business_id, provider_account_id, date DESC)`.catch(() => {}),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS truth_state TEXT NOT NULL DEFAULT 'finalized'`.catch(() => {}),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS truth_version INTEGER NOT NULL DEFAULT 1`.catch(() => {}),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'passed'`.catch(() => {}),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS source_run_id TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS metric_schema_version INTEGER NOT NULL DEFAULT 1`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_campaign_daily (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          date                    DATE NOT NULL,
          campaign_id             TEXT NOT NULL,
          campaign_name_current   TEXT,
          campaign_name_historical TEXT,
          campaign_status         TEXT,
          objective               TEXT,
          buying_type             TEXT,
          optimization_goal       TEXT,
          bid_strategy_type       TEXT,
          bid_strategy_label      TEXT,
          manual_bid_amount       DOUBLE PRECISION,
          bid_value               DOUBLE PRECISION,
          bid_value_format        TEXT,
          daily_budget            DOUBLE PRECISION,
          lifetime_budget         DOUBLE PRECISION,
          is_budget_mixed         BOOLEAN NOT NULL DEFAULT FALSE,
          is_config_mixed         BOOLEAN NOT NULL DEFAULT FALSE,
          is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_strategy_mixed   BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_value_mixed      BOOLEAN NOT NULL DEFAULT FALSE,
          account_timezone        TEXT NOT NULL,
          account_currency        TEXT NOT NULL,
          spend                   DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions             BIGINT NOT NULL DEFAULT 0,
          clicks                  BIGINT NOT NULL DEFAULT 0,
          reach                   BIGINT NOT NULL DEFAULT 0,
          frequency               DOUBLE PRECISION,
          conversions             DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue                 DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                    DOUBLE PRECISION NOT NULL DEFAULT 0,
          cpa                     DOUBLE PRECISION,
          ctr                     DOUBLE PRECISION,
          cpc                     DOUBLE PRECISION,
          source_snapshot_id      UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          metric_schema_version   INTEGER NOT NULL DEFAULT 1,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, campaign_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_daily_business_date ON meta_campaign_daily (business_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_daily_account_date ON meta_campaign_daily (provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_daily_campaign ON meta_campaign_daily (campaign_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_daily_business_account_date
          ON meta_campaign_daily (business_id, provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_daily_business_date_campaign
          ON meta_campaign_daily (business_id, date DESC, campaign_id)`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS optimization_goal TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS bid_strategy_type TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS bid_strategy_label TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS manual_bid_amount DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS bid_value DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS bid_value_format TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS daily_budget DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS lifetime_budget DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS is_budget_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS is_config_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS is_bid_strategy_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS is_bid_value_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS truth_state TEXT NOT NULL DEFAULT 'finalized'`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS truth_version INTEGER NOT NULL DEFAULT 1`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'passed'`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS source_run_id TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS metric_schema_version INTEGER NOT NULL DEFAULT 1`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_adset_daily (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          date                 DATE NOT NULL,
          campaign_id          TEXT,
          adset_id             TEXT NOT NULL,
          adset_name_current   TEXT,
          adset_name_historical TEXT,
          adset_status         TEXT,
          optimization_goal    TEXT,
          bid_strategy_type    TEXT,
          bid_strategy_label   TEXT,
          manual_bid_amount    DOUBLE PRECISION,
          bid_value            DOUBLE PRECISION,
          bid_value_format     TEXT,
          daily_budget         DOUBLE PRECISION,
          lifetime_budget      DOUBLE PRECISION,
          is_budget_mixed      BOOLEAN NOT NULL DEFAULT FALSE,
          is_config_mixed      BOOLEAN NOT NULL DEFAULT FALSE,
          is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_strategy_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_value_mixed   BOOLEAN NOT NULL DEFAULT FALSE,
          account_timezone     TEXT NOT NULL,
          account_currency     TEXT NOT NULL,
          spend                DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions          BIGINT NOT NULL DEFAULT 0,
          clicks               BIGINT NOT NULL DEFAULT 0,
          reach                BIGINT NOT NULL DEFAULT 0,
          frequency            DOUBLE PRECISION,
          conversions          DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue              DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                 DOUBLE PRECISION NOT NULL DEFAULT 0,
          cpa                  DOUBLE PRECISION,
          ctr                  DOUBLE PRECISION,
          cpc                  DOUBLE PRECISION,
          source_snapshot_id   UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          metric_schema_version INTEGER NOT NULL DEFAULT 1,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, adset_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_daily_business_date ON meta_adset_daily (business_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_daily_account_date ON meta_adset_daily (provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_daily_adset ON meta_adset_daily (adset_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_daily_business_account_date
          ON meta_adset_daily (business_id, provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_daily_business_date_adset
          ON meta_adset_daily (business_id, date DESC, adset_id)`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS optimization_goal TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS bid_strategy_type TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS bid_strategy_label TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS manual_bid_amount DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS bid_value DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS bid_value_format TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS daily_budget DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS lifetime_budget DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS is_budget_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS is_config_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS is_bid_strategy_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS is_bid_value_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS truth_state TEXT NOT NULL DEFAULT 'finalized'`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS truth_version INTEGER NOT NULL DEFAULT 1`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'passed'`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS source_run_id TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS metric_schema_version INTEGER NOT NULL DEFAULT 1`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_breakdown_daily (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          date                DATE NOT NULL,
          breakdown_type      TEXT NOT NULL,
          breakdown_key       TEXT NOT NULL,
          breakdown_label     TEXT NOT NULL,
          account_timezone    TEXT NOT NULL,
          account_currency    TEXT NOT NULL,
          spend               DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions         BIGINT NOT NULL DEFAULT 0,
          clicks              BIGINT NOT NULL DEFAULT 0,
          reach               BIGINT NOT NULL DEFAULT 0,
          frequency           DOUBLE PRECISION,
          conversions         DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue             DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                DOUBLE PRECISION NOT NULL DEFAULT 0,
          cpa                 DOUBLE PRECISION,
          ctr                 DOUBLE PRECISION,
          cpc                 DOUBLE PRECISION,
          source_snapshot_id  UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          truth_state         TEXT NOT NULL DEFAULT 'finalized',
          truth_version       INTEGER NOT NULL DEFAULT 1,
          finalized_at        TIMESTAMPTZ,
          validation_status   TEXT NOT NULL DEFAULT 'passed',
          source_run_id       TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, breakdown_type, breakdown_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_breakdown_daily_business_date
          ON meta_breakdown_daily (business_id, date DESC, breakdown_type)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_breakdown_daily_account_date
          ON meta_breakdown_daily (provider_account_id, date DESC, breakdown_type)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_ad_daily (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          date                DATE NOT NULL,
          campaign_id         TEXT,
          adset_id            TEXT,
          ad_id               TEXT NOT NULL,
          ad_name_current     TEXT,
          ad_name_historical  TEXT,
          ad_status           TEXT,
          account_timezone    TEXT NOT NULL,
          account_currency    TEXT NOT NULL,
          spend               DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions         BIGINT NOT NULL DEFAULT 0,
          clicks              BIGINT NOT NULL DEFAULT 0,
          reach               BIGINT NOT NULL DEFAULT 0,
          frequency           DOUBLE PRECISION,
          conversions         DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue             DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                DOUBLE PRECISION NOT NULL DEFAULT 0,
          cpa                 DOUBLE PRECISION,
          ctr                 DOUBLE PRECISION,
          cpc                 DOUBLE PRECISION,
          link_clicks         BIGINT NOT NULL DEFAULT 0,
          source_snapshot_id  UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          truth_state         TEXT NOT NULL DEFAULT 'finalized',
          truth_version       INTEGER NOT NULL DEFAULT 1,
          finalized_at        TIMESTAMPTZ,
          validation_status   TEXT NOT NULL DEFAULT 'passed',
          source_run_id       TEXT,
          metric_schema_version INTEGER NOT NULL DEFAULT 1,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, ad_id)
        )`.catch(() => {}),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS payload_json JSONB`.catch(() => {}),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS link_clicks BIGINT NOT NULL DEFAULT 0`.catch(() => {}),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS truth_state TEXT NOT NULL DEFAULT 'finalized'`.catch(() => {}),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS truth_version INTEGER NOT NULL DEFAULT 1`.catch(() => {}),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'passed'`.catch(() => {}),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS source_run_id TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS metric_schema_version INTEGER NOT NULL DEFAULT 1`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_business_date ON meta_ad_daily (business_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_account_date ON meta_ad_daily (provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_ad ON meta_ad_daily (ad_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_business_account_date
          ON meta_ad_daily (business_id, provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_business_date_ad
          ON meta_ad_daily (business_id, date DESC, ad_id)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_creative_daily (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          date                DATE NOT NULL,
          campaign_id         TEXT,
          adset_id            TEXT,
          ad_id               TEXT,
          creative_id         TEXT NOT NULL,
          creative_name       TEXT,
          headline            TEXT,
          primary_text        TEXT,
          destination_url     TEXT,
          thumbnail_url       TEXT,
          asset_type          TEXT,
          account_timezone    TEXT NOT NULL,
          account_currency    TEXT NOT NULL,
          spend               DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions         BIGINT NOT NULL DEFAULT 0,
          clicks              BIGINT NOT NULL DEFAULT 0,
          conversions         DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue             DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                DOUBLE PRECISION NOT NULL DEFAULT 0,
          ctr                 DOUBLE PRECISION,
          cpc                 DOUBLE PRECISION,
          link_clicks         BIGINT NOT NULL DEFAULT 0,
          source_snapshot_id  UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          source_run_id       TEXT,
          metric_schema_version INTEGER NOT NULL DEFAULT 1,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, creative_id)
        )`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS payload_json JSONB`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS business_ref_id UUID REFERENCES businesses(id) ON DELETE SET NULL`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS reach BIGINT NOT NULL DEFAULT 0`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS frequency DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS cpa DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS link_clicks BIGINT NOT NULL DEFAULT 0`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS outbound_clicks BIGINT NOT NULL DEFAULT 0`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS description_text TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS launch_date DATE`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS first_spend_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS effective_status TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS objective TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS attribution_setting TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS quality_ranking TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS engagement_rate_ranking TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS conversion_rate_ranking TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS bid_strategy TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS optimization_goal TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS campaign_daily_budget DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS adset_daily_budget DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS campaign_lifetime_budget DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS adset_lifetime_budget DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS creative_delivery_type TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS creative_visual_format TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS creative_primary_type TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS creative_secondary_type TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS image_hash TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS source_run_id TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS metric_schema_version INTEGER NOT NULL DEFAULT 1`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_business_date ON meta_creative_daily (business_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_account_date ON meta_creative_daily (provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_creative ON meta_creative_daily (creative_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_business_account_date
          ON meta_creative_daily (business_id, provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_business_account_date_creative
          ON meta_creative_daily (business_id, provider_account_id, date DESC, creative_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_image_hash
          ON meta_creative_daily (business_id, provider_account_id, image_hash)
          WHERE image_hash IS NOT NULL`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_creative_media (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          date                    DATE NOT NULL,
          campaign_id             TEXT,
          adset_id                TEXT,
          ad_id                   TEXT,
          creative_id             TEXT NOT NULL,
          preview_url             TEXT,
          thumbnail_url           TEXT,
          image_url               TEXT,
          table_thumbnail_url     TEXT,
          card_preview_url        TEXT,
          video_url               TEXT,
          poster_url              TEXT,
          preview_html            TEXT,
          media_cache_key         TEXT,
          image_hash              TEXT,
          payload_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_run_id           TEXT,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`ALTER TABLE meta_creative_media
          DROP CONSTRAINT IF EXISTS meta_creative_media_business_id_provider_account_id_date_creative_id_key`.catch(() => {}),
        sql`DO $migration$
          DECLARE old_constraint_name TEXT;
          BEGIN
            SELECT conname INTO old_constraint_name
            FROM pg_constraint
            WHERE conrelid = 'meta_creative_media'::regclass
              AND contype = 'u'
              AND pg_get_constraintdef(oid) LIKE 'UNIQUE (business_id, provider_account_id, date, creative_id)%'
            LIMIT 1;
            IF old_constraint_name IS NOT NULL THEN
              EXECUTE format('ALTER TABLE meta_creative_media DROP CONSTRAINT %I', old_constraint_name);
            END IF;
          END
        $migration$`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_creative_media_ad_grain
          ON meta_creative_media (business_id, provider_account_id, date, creative_id, (COALESCE(ad_id, '')))`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_media_business_date
          ON meta_creative_media (business_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_media_account_date
          ON meta_creative_media (provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_media_creative
          ON meta_creative_media (creative_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_media_image_hash
          ON meta_creative_media (business_id, provider_account_id, image_hash)
          WHERE image_hash IS NOT NULL`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_campaign_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT NOT NULL,
          campaign_name           TEXT,
          normalized_status       TEXT,
          channel                 TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, campaign_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_campaign_dimensions_business_account
          ON google_ads_campaign_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_campaign_dimensions_campaign
          ON google_ads_campaign_dimensions (campaign_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_campaign_state_history (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT NOT NULL,
          state_fingerprint       TEXT NOT NULL,
          campaign_name           TEXT,
          normalized_status       TEXT,
          channel                 TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_kind             TEXT NOT NULL DEFAULT 'warehouse_daily',
          source_snapshot_id      UUID REFERENCES google_ads_raw_snapshots(id) ON DELETE SET NULL,
          captured_at             TIMESTAMPTZ NOT NULL,
          effective_from          DATE,
          effective_to            DATE,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, campaign_id, state_fingerprint, captured_at)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_campaign_state_history_lookup
          ON google_ads_campaign_state_history (business_id, campaign_id, captured_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_ad_group_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          ad_group_id             TEXT NOT NULL,
          ad_group_name           TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, ad_group_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_ad_group_dimensions_business_account
          ON google_ads_ad_group_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_ad_group_dimensions_ad_group
          ON google_ads_ad_group_dimensions (ad_group_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_ad_group_state_history (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          ad_group_id             TEXT NOT NULL,
          state_fingerprint       TEXT NOT NULL,
          ad_group_name           TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_kind             TEXT NOT NULL DEFAULT 'warehouse_daily',
          source_snapshot_id      UUID REFERENCES google_ads_raw_snapshots(id) ON DELETE SET NULL,
          captured_at             TIMESTAMPTZ NOT NULL,
          effective_from          DATE,
          effective_to            DATE,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, ad_group_id, state_fingerprint, captured_at)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_ad_group_state_history_lookup
          ON google_ads_ad_group_state_history (business_id, ad_group_id, captured_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_ad_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          ad_group_id             TEXT,
          ad_id                   TEXT NOT NULL,
          ad_name                 TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, ad_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_ad_dimensions_business_account
          ON google_ads_ad_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_ad_dimensions_ad
          ON google_ads_ad_dimensions (ad_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_keyword_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          ad_group_id             TEXT,
          keyword_id              TEXT NOT NULL,
          keyword_text            TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, keyword_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_keyword_dimensions_business_account
          ON google_ads_keyword_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_keyword_dimensions_keyword
          ON google_ads_keyword_dimensions (keyword_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_asset_group_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          asset_group_id          TEXT NOT NULL,
          asset_group_name        TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, asset_group_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_asset_group_dimensions_business_account
          ON google_ads_asset_group_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_asset_group_dimensions_asset_group
          ON google_ads_asset_group_dimensions (asset_group_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_product_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          product_key             TEXT NOT NULL,
          product_title           TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, product_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_product_dimensions_business_account
          ON google_ads_product_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_product_dimensions_product
          ON google_ads_product_dimensions (product_key, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_campaign_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          campaign_id             TEXT NOT NULL,
          campaign_name_current   TEXT,
          campaign_name_historical TEXT,
          campaign_status         TEXT,
          buying_type             TEXT,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, campaign_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_dimensions_business_account
          ON meta_campaign_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_dimensions_campaign
          ON meta_campaign_dimensions (campaign_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_campaign_config_history (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id               TEXT NOT NULL,
          provider_account_id       TEXT NOT NULL,
          campaign_id               TEXT NOT NULL,
          config_fingerprint        TEXT NOT NULL,
          objective                 TEXT,
          optimization_goal         TEXT,
          bid_strategy_type         TEXT,
          bid_strategy_label        TEXT,
          manual_bid_amount         DOUBLE PRECISION,
          bid_value                 DOUBLE PRECISION,
          bid_value_format          TEXT,
          daily_budget              DOUBLE PRECISION,
          lifetime_budget           DOUBLE PRECISION,
          is_budget_mixed           BOOLEAN NOT NULL DEFAULT FALSE,
          is_config_mixed           BOOLEAN NOT NULL DEFAULT FALSE,
          is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_strategy_mixed     BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_value_mixed        BOOLEAN NOT NULL DEFAULT FALSE,
          source_kind               TEXT NOT NULL DEFAULT 'warehouse_daily',
          source_snapshot_id        UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          captured_at               TIMESTAMPTZ NOT NULL,
          effective_from            DATE,
          effective_to              DATE,
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, campaign_id, config_fingerprint, captured_at)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_config_history_lookup
          ON meta_campaign_config_history (business_id, campaign_id, captured_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_adset_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          campaign_id             TEXT,
          adset_id                TEXT NOT NULL,
          adset_name_current      TEXT,
          adset_name_historical   TEXT,
          adset_status            TEXT,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, adset_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_dimensions_business_account
          ON meta_adset_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_dimensions_adset
          ON meta_adset_dimensions (adset_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_adset_config_history (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id               TEXT NOT NULL,
          provider_account_id       TEXT NOT NULL,
          campaign_id               TEXT,
          adset_id                  TEXT NOT NULL,
          config_fingerprint        TEXT NOT NULL,
          optimization_goal         TEXT,
          bid_strategy_type         TEXT,
          bid_strategy_label        TEXT,
          manual_bid_amount         DOUBLE PRECISION,
          bid_value                 DOUBLE PRECISION,
          bid_value_format          TEXT,
          daily_budget              DOUBLE PRECISION,
          lifetime_budget           DOUBLE PRECISION,
          is_budget_mixed           BOOLEAN NOT NULL DEFAULT FALSE,
          is_config_mixed           BOOLEAN NOT NULL DEFAULT FALSE,
          is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_strategy_mixed     BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_value_mixed        BOOLEAN NOT NULL DEFAULT FALSE,
          source_kind               TEXT NOT NULL DEFAULT 'warehouse_daily',
          source_snapshot_id        UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          captured_at               TIMESTAMPTZ NOT NULL,
          effective_from            DATE,
          effective_to              DATE,
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, adset_id, config_fingerprint, captured_at)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_config_history_lookup
          ON meta_adset_config_history (business_id, adset_id, captured_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_ad_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          campaign_id             TEXT,
          adset_id                TEXT,
          ad_id                   TEXT NOT NULL,
          ad_name_current         TEXT,
          ad_name_historical      TEXT,
          ad_status               TEXT,
          creative_id             TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, ad_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_dimensions_business_account
          ON meta_ad_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_dimensions_ad
          ON meta_ad_dimensions (ad_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_creative_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          campaign_id             TEXT,
          adset_id                TEXT,
          ad_id                   TEXT,
          creative_id             TEXT NOT NULL,
          creative_name           TEXT,
          headline                TEXT,
          primary_text            TEXT,
          destination_url         TEXT,
          thumbnail_url           TEXT,
          asset_type              TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, creative_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_dimensions_business_account
          ON meta_creative_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_dimensions_creative
          ON meta_creative_dimensions (creative_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_creative_score_snapshots (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          creative_id         TEXT NOT NULL,
          as_of_date          DATE NOT NULL,
          selected_start_date DATE NOT NULL,
          selected_end_date   DATE NOT NULL,
          window_metrics      JSONB NOT NULL DEFAULT '{}'::jsonb,
          selected_row_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
          weighted_score      DOUBLE PRECISION,
          label               TEXT,
          computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          freshness_state     TEXT NOT NULL DEFAULT 'fresh',
          rule_version        TEXT NOT NULL,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (
            business_id,
            provider_account_id,
            creative_id,
            as_of_date,
            selected_start_date,
            selected_end_date,
            rule_version
          )
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_score_snapshots_lookup ON meta_creative_score_snapshots (business_id, selected_start_date, selected_end_date, as_of_date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_score_snapshots_creative ON meta_creative_score_snapshots (creative_id, as_of_date DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_authoritative_source_manifests (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          day                     DATE NOT NULL,
          surface                 TEXT NOT NULL,
          account_timezone        TEXT NOT NULL,
          source_kind             TEXT NOT NULL,
          source_window_kind      TEXT NOT NULL,
          run_id                  TEXT,
          fetch_status            TEXT NOT NULL DEFAULT 'pending',
          fresh_start_applied     BOOLEAN NOT NULL DEFAULT FALSE,
          checkpoint_reset_applied BOOLEAN NOT NULL DEFAULT FALSE,
          raw_snapshot_watermark  TEXT,
          source_spend            DOUBLE PRECISION,
          validation_basis_version TEXT,
          meta_json               JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at              TIMESTAMPTZ,
          completed_at            TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_source_manifests_lookup
          ON meta_authoritative_source_manifests (business_id, provider_account_id, day DESC, surface, created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_source_manifests_run
          ON meta_authoritative_source_manifests (run_id, created_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_authoritative_slice_versions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          day                     DATE NOT NULL,
          surface                 TEXT NOT NULL,
          manifest_id             UUID REFERENCES meta_authoritative_source_manifests(id) ON DELETE SET NULL,
          candidate_version       INTEGER NOT NULL,
          state                   TEXT NOT NULL DEFAULT 'pending_finalization',
          truth_state             TEXT NOT NULL DEFAULT 'finalized',
          validation_status       TEXT NOT NULL DEFAULT 'pending',
          status                  TEXT NOT NULL DEFAULT 'staging',
          staged_row_count        INTEGER,
          aggregated_spend        DOUBLE PRECISION,
          validation_summary      JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_run_id           TEXT,
          stage_started_at        TIMESTAMPTZ,
          stage_completed_at      TIMESTAMPTZ,
          publish_started_at      TIMESTAMPTZ,
          published_at            TIMESTAMPTZ,
          superseded_at           TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, day, surface, candidate_version)
        )`.catch(() => {}),
        sql`ALTER TABLE IF EXISTS meta_authoritative_slice_versions
          ADD COLUMN IF NOT EXISTS publish_started_at TIMESTAMPTZ`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_slice_versions_lookup
          ON meta_authoritative_slice_versions (business_id, provider_account_id, day DESC, surface, candidate_version DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_slice_versions_manifest
          ON meta_authoritative_slice_versions (manifest_id, created_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_authoritative_publication_pointers (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          day                     DATE NOT NULL,
          surface                 TEXT NOT NULL,
          active_slice_version_id UUID NOT NULL REFERENCES meta_authoritative_slice_versions(id) ON DELETE CASCADE,
          published_by_run_id     TEXT,
          publication_reason      TEXT NOT NULL,
          published_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, day, surface)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_publication_pointers_slice
          ON meta_authoritative_publication_pointers (active_slice_version_id, published_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_authoritative_reconciliation_events (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          day                     DATE NOT NULL,
          surface                 TEXT NOT NULL,
          slice_version_id        UUID REFERENCES meta_authoritative_slice_versions(id) ON DELETE SET NULL,
          manifest_id             UUID REFERENCES meta_authoritative_source_manifests(id) ON DELETE SET NULL,
          event_kind              TEXT NOT NULL,
          severity                TEXT NOT NULL DEFAULT 'info',
          source_spend            DOUBLE PRECISION,
          warehouse_account_spend DOUBLE PRECISION,
          warehouse_campaign_spend DOUBLE PRECISION,
          tolerance_applied       DOUBLE PRECISION,
          result                  TEXT NOT NULL,
          details_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_reconciliation_events_lookup
          ON meta_authoritative_reconciliation_events (business_id, provider_account_id, day DESC, surface, created_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_authoritative_day_state (
          business_id                TEXT NOT NULL,
          provider_account_id        TEXT NOT NULL,
          day                        DATE NOT NULL,
          surface                    TEXT NOT NULL CHECK (surface IN ('account_daily', 'campaign_daily', 'adset_daily', 'ad_daily', 'breakdown_daily')),
          state                      TEXT NOT NULL DEFAULT 'pending'
                                    CHECK (state IN ('pending', 'queued', 'running', 'published', 'repair_required', 'failed', 'blocked', 'not_applicable')),
          account_timezone           TEXT NOT NULL DEFAULT 'UTC',
          active_partition_id        UUID,
          last_run_id                TEXT,
          last_manifest_id           UUID,
          last_publication_pointer_id UUID,
          published_at               TIMESTAMPTZ,
          retry_after_at             TIMESTAMPTZ,
          failure_streak             INTEGER NOT NULL DEFAULT 0,
          diagnosis_code             TEXT,
          diagnosis_detail_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
          last_started_at            TIMESTAMPTZ,
          last_finished_at           TIMESTAMPTZ,
          last_autoheal_at           TIMESTAMPTZ,
          autoheal_count             INTEGER NOT NULL DEFAULT 0,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, day, surface)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_day_state_business_day
          ON meta_authoritative_day_state (business_id, provider_account_id, day DESC, surface)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_day_state_status
          ON meta_authoritative_day_state (business_id, state, day DESC, surface)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_retention_runs (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          execution_mode           TEXT NOT NULL CHECK (execution_mode IN ('dry_run', 'execute')),
          execution_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
          skipped_due_to_active_lease BOOLEAN NOT NULL DEFAULT FALSE,
          total_deleted_rows       INTEGER NOT NULL DEFAULT 0,
          summary_json             JSONB NOT NULL DEFAULT '{}'::jsonb,
          error_message            TEXT,
          started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at              TIMESTAMPTZ,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_retention_runs_finished
          ON meta_retention_runs (finished_at DESC NULLS LAST, created_at DESC)`.catch(() => {}),
        // ── Google Ads warehouse-first tables ──────────────────────────────
        sql`CREATE TABLE IF NOT EXISTS google_ads_sync_jobs (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          sync_type           TEXT NOT NULL
                              CHECK (sync_type IN ('initial_backfill', 'incremental_recent', 'today_refresh', 'repair_window', 'reconnect_backfill')),
          scope               TEXT NOT NULL DEFAULT 'account_daily',
          start_date          DATE NOT NULL,
          end_date            DATE NOT NULL,
          status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
          progress_percent    DOUBLE PRECISION NOT NULL DEFAULT 0,
          trigger_source      TEXT NOT NULL DEFAULT 'system',
          retry_count         INTEGER NOT NULL DEFAULT 0,
          last_error          TEXT,
          triggered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_jobs_business ON google_ads_sync_jobs (business_id, triggered_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_jobs_account ON google_ads_sync_jobs (provider_account_id, triggered_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_jobs_status ON google_ads_sync_jobs (status, triggered_at DESC)`.catch(() => {}),
        sql`
          WITH ranked AS (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY business_id, provider_account_id, sync_type, scope, start_date, end_date, trigger_source
                ORDER BY updated_at DESC, triggered_at DESC, id DESC
              ) AS row_number
            FROM google_ads_sync_jobs
            WHERE status = 'running'
          )
          UPDATE google_ads_sync_jobs job
          SET
            status = 'failed',
            last_error = COALESCE(job.last_error, 'duplicate running sync job cleaned up during migration'),
            finished_at = now(),
            updated_at = now()
          FROM ranked
          WHERE job.id = ranked.id
            AND ranked.row_number > 1
        `.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_google_ads_sync_jobs_running_unique
          ON google_ads_sync_jobs (
            business_id,
            provider_account_id,
            sync_type,
            scope,
            start_date,
            end_date,
            trigger_source
          )
          WHERE status = 'running'`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_runner_leases (
          business_id       TEXT NOT NULL,
          lane              TEXT NOT NULL CHECK (lane IN ('core', 'extended', 'maintenance')),
          lease_owner       TEXT NOT NULL,
          lease_expires_at  TIMESTAMPTZ NOT NULL,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, lane)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_runner_leases_expiry
          ON google_ads_runner_leases (lease_expires_at, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_sync_partitions (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          lane                TEXT NOT NULL CHECK (lane IN ('core', 'extended', 'maintenance')),
          scope               TEXT NOT NULL,
          partition_date      DATE NOT NULL,
          status              TEXT NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
          priority            INTEGER NOT NULL DEFAULT 0,
          source              TEXT NOT NULL DEFAULT 'system',
          lease_owner         TEXT,
          lease_expires_at    TIMESTAMPTZ,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          next_retry_at       TIMESTAMPTZ,
          last_error          TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, lane, scope, partition_date)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_partitions_queue
          ON google_ads_sync_partitions (business_id, lane, status, priority DESC, partition_date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_partitions_lease
          ON google_ads_sync_partitions (status, lease_expires_at, next_retry_at, updated_at DESC)`.catch(() => {}),
        sql`ALTER TABLE google_ads_sync_partitions ADD COLUMN IF NOT EXISTS lease_epoch BIGINT NOT NULL DEFAULT 0`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_sync_runs (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          partition_id        UUID REFERENCES google_ads_sync_partitions(id) ON DELETE CASCADE,
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          lane                TEXT NOT NULL CHECK (lane IN ('core', 'extended', 'maintenance')),
          scope               TEXT NOT NULL,
          partition_date      DATE NOT NULL,
          status              TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
          worker_id           TEXT,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          row_count           INTEGER,
          duration_ms         INTEGER,
          error_class         TEXT,
          error_message       TEXT,
          meta_json           JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_runs_partition ON google_ads_sync_runs (partition_id, created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_runs_business ON google_ads_sync_runs (business_id, created_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_sync_checkpoints (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          partition_id               UUID NOT NULL REFERENCES google_ads_sync_partitions(id) ON DELETE CASCADE,
          business_id                TEXT NOT NULL,
          provider_account_id        TEXT NOT NULL,
          checkpoint_scope           TEXT NOT NULL,
          phase                      TEXT NOT NULL
                                      CHECK (phase IN ('fetch_raw', 'transform', 'bulk_upsert', 'finalize')),
          status                     TEXT NOT NULL
                                      CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
          page_index                 INTEGER NOT NULL DEFAULT 0,
          next_page_token            TEXT,
          provider_cursor            TEXT,
          rows_fetched               INTEGER NOT NULL DEFAULT 0,
          rows_written               INTEGER NOT NULL DEFAULT 0,
          last_successful_entity_key TEXT,
          last_response_headers      JSONB NOT NULL DEFAULT '{}'::jsonb,
          checkpoint_hash            TEXT,
          attempt_count              INTEGER NOT NULL DEFAULT 0,
          retry_after_at             TIMESTAMPTZ,
          lease_owner                TEXT,
          lease_expires_at           TIMESTAMPTZ,
          started_at                 TIMESTAMPTZ,
          finished_at                TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (partition_id, checkpoint_scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_checkpoints_partition
          ON google_ads_sync_checkpoints (partition_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_checkpoints_scope
          ON google_ads_sync_checkpoints (business_id, provider_account_id, checkpoint_scope, status, updated_at DESC)`.catch(() => {}),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS lease_epoch BIGINT`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_checkpoints_partition_epoch
          ON google_ads_sync_checkpoints (partition_id, lease_epoch, updated_at DESC)`.catch(() => {}),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS is_paginated BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS raw_snapshot_ids JSONB NOT NULL DEFAULT '[]'::jsonb`.catch(() => {}),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS progress_heartbeat_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS poisoned_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS poison_reason TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS replay_reason_code TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS replay_detail TEXT`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_sync_state (
          business_id                  TEXT NOT NULL,
          provider_account_id          TEXT NOT NULL,
          scope                        TEXT NOT NULL,
          historical_target_start      DATE NOT NULL,
          historical_target_end        DATE NOT NULL,
          effective_target_start       DATE NOT NULL,
          effective_target_end         DATE NOT NULL,
          ready_through_date           DATE,
          last_successful_partition_date DATE,
          latest_background_activity_at TIMESTAMPTZ,
          latest_successful_sync_at    TIMESTAMPTZ,
          completed_days               INTEGER NOT NULL DEFAULT 0,
          dead_letter_count            INTEGER NOT NULL DEFAULT 0,
          updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_state_business
          ON google_ads_sync_state (business_id, scope, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_raw_snapshots (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          endpoint_name        TEXT NOT NULL,
          entity_scope         TEXT NOT NULL DEFAULT 'account',
          start_date           DATE NOT NULL,
          end_date             DATE NOT NULL,
          account_timezone     TEXT,
          account_currency     TEXT,
          payload_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          payload_hash         TEXT NOT NULL,
          request_context      JSONB NOT NULL DEFAULT '{}'::jsonb,
          provider_http_status INTEGER,
          status               TEXT NOT NULL DEFAULT 'fetched'
                               CHECK (status IN ('fetched', 'partial', 'failed')),
          fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_business ON google_ads_raw_snapshots (business_id, fetched_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_account ON google_ads_raw_snapshots (provider_account_id, fetched_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_window ON google_ads_raw_snapshots (business_id, provider_account_id, start_date, end_date)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_endpoint ON google_ads_raw_snapshots (endpoint_name, fetched_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_partition_endpoint
          ON google_ads_raw_snapshots (partition_id, endpoint_name, page_index)`.catch(() => {}),
        sql`ALTER TABLE google_ads_raw_snapshots ADD COLUMN IF NOT EXISTS partition_id UUID REFERENCES google_ads_sync_partitions(id) ON DELETE CASCADE`.catch(() => {}),
        sql`ALTER TABLE google_ads_raw_snapshots ADD COLUMN IF NOT EXISTS checkpoint_id UUID REFERENCES google_ads_sync_checkpoints(id) ON DELETE SET NULL`.catch(() => {}),
        sql`ALTER TABLE google_ads_raw_snapshots ADD COLUMN IF NOT EXISTS page_index INTEGER`.catch(() => {}),
        sql`ALTER TABLE google_ads_raw_snapshots ADD COLUMN IF NOT EXISTS provider_cursor TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_raw_snapshots ADD COLUMN IF NOT EXISTS response_headers JSONB NOT NULL DEFAULT '{}'::jsonb`.catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_account_daily")).catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_campaign_daily")).catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_ad_group_daily")).catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_ad_daily")).catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_keyword_daily")).catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_search_term_daily")).catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_asset_group_daily")).catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_asset_daily")).catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_audience_daily")).catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_geo_daily")).catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_device_daily")).catch(() => {}),
        sql.query(buildGoogleAdsWarehouseTableQuery("google_ads_product_daily")).catch(() => {}),
        sql`ALTER TABLE google_ads_search_term_daily ADD COLUMN IF NOT EXISTS query_hash TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_search_term_daily ADD COLUMN IF NOT EXISTS normalized_query TEXT`.catch(() => {}),
        sql`ALTER TABLE google_ads_search_term_daily ADD COLUMN IF NOT EXISTS cluster_key TEXT`.catch(() => {}),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_account_daily").map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_campaign_daily").map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_ad_group_daily").map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_ad_daily").map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_keyword_daily").map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_search_term_daily").map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_asset_group_daily").map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_asset_daily").map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_audience_daily").map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_geo_daily").map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_device_daily").map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_product_daily").map((query) => sql.query(query).catch(() => {})),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_search_term_daily_query_hash
          ON google_ads_search_term_daily (business_id, date DESC, query_hash)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_query_dictionary (
          query_hash       TEXT PRIMARY KEY,
          normalized_query TEXT NOT NULL,
          display_query    TEXT NOT NULL,
          token_count      INTEGER NOT NULL DEFAULT 0,
          first_seen_date  DATE NOT NULL,
          last_seen_date   DATE NOT NULL,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_google_ads_query_dictionary_normalized
          ON google_ads_query_dictionary (normalized_query)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_search_query_hot_daily (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          date               DATE NOT NULL,
          account_timezone   TEXT NOT NULL DEFAULT 'UTC',
          account_currency   TEXT NOT NULL DEFAULT 'USD',
          query_hash         TEXT NOT NULL REFERENCES google_ads_query_dictionary(query_hash) ON DELETE RESTRICT,
          campaign_id        TEXT,
          campaign_name      TEXT,
          ad_group_id        TEXT,
          ad_group_name      TEXT,
          cluster_key        TEXT NOT NULL,
          cluster_label      TEXT NOT NULL,
          theme_key          TEXT,
          intent_class       TEXT,
          ownership_class    TEXT,
          spend              NUMERIC(18, 4) NOT NULL DEFAULT 0,
          revenue            NUMERIC(18, 4) NOT NULL DEFAULT 0,
          conversions        NUMERIC(18, 4) NOT NULL DEFAULT 0,
          impressions        BIGINT NOT NULL DEFAULT 0,
          clicks             BIGINT NOT NULL DEFAULT 0,
          source_snapshot_id UUID REFERENCES google_ads_raw_snapshots(id) ON DELETE SET NULL,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, query_hash, campaign_id, ad_group_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_search_query_hot_daily_business_date
          ON google_ads_search_query_hot_daily (business_id, provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_search_query_hot_daily_query
          ON google_ads_search_query_hot_daily (query_hash, date DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_top_query_weekly (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          week_start         DATE NOT NULL,
          week_end           DATE NOT NULL,
          query_hash         TEXT NOT NULL REFERENCES google_ads_query_dictionary(query_hash) ON DELETE RESTRICT,
          query_count_days   INTEGER NOT NULL DEFAULT 0,
          spend              NUMERIC(18, 4) NOT NULL DEFAULT 0,
          revenue            NUMERIC(18, 4) NOT NULL DEFAULT 0,
          conversions        NUMERIC(18, 4) NOT NULL DEFAULT 0,
          impressions        BIGINT NOT NULL DEFAULT 0,
          clicks             BIGINT NOT NULL DEFAULT 0,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, week_start, query_hash)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_top_query_weekly_business
          ON google_ads_top_query_weekly (business_id, provider_account_id, week_start DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_search_cluster_daily (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          date                    DATE NOT NULL,
          cluster_key             TEXT NOT NULL,
          cluster_label           TEXT NOT NULL,
          theme_key               TEXT,
          dominant_intent_class   TEXT,
          dominant_ownership_class TEXT,
          unique_query_count      INTEGER NOT NULL DEFAULT 0,
          spend                   NUMERIC(18, 4) NOT NULL DEFAULT 0,
          revenue                 NUMERIC(18, 4) NOT NULL DEFAULT 0,
          conversions             NUMERIC(18, 4) NOT NULL DEFAULT 0,
          impressions             BIGINT NOT NULL DEFAULT 0,
          clicks                  BIGINT NOT NULL DEFAULT 0,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, cluster_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_search_cluster_daily_business
          ON google_ads_search_cluster_daily (business_id, provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_decision_action_outcome_logs (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id              TEXT NOT NULL,
          provider_account_id      TEXT,
          recommendation_fingerprint TEXT NOT NULL,
          decision_family          TEXT,
          action_type              TEXT NOT NULL,
          outcome_status           TEXT,
          summary                  TEXT NOT NULL,
          payload_json             JSONB NOT NULL DEFAULT '{}'::jsonb,
          occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_decision_action_outcome_logs_business
          ON google_ads_decision_action_outcome_logs (business_id, occurred_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_decision_action_outcome_logs_recommendation
          ON google_ads_decision_action_outcome_logs (recommendation_fingerprint, occurred_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_retention_runs (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          execution_mode             TEXT NOT NULL
                                     CHECK (execution_mode IN ('dry_run', 'execute')),
          execution_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
          skipped_due_to_active_lease BOOLEAN NOT NULL DEFAULT FALSE,
          total_deleted_rows         INTEGER NOT NULL DEFAULT 0,
          summary_json               JSONB NOT NULL DEFAULT '{}'::jsonb,
          error_message              TEXT,
          started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at                TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_retention_runs_finished
          ON google_ads_retention_runs (finished_at DESC NULLS LAST, created_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_raw_snapshots (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          endpoint_name        TEXT NOT NULL,
          entity_scope         TEXT NOT NULL DEFAULT 'shop',
          start_date           DATE,
          end_date             DATE,
          payload_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          payload_hash         TEXT NOT NULL,
          request_context      JSONB NOT NULL DEFAULT '{}'::jsonb,
          response_headers     JSONB NOT NULL DEFAULT '{}'::jsonb,
          provider_http_status INTEGER,
          status               TEXT NOT NULL DEFAULT 'fetched'
                               CHECK (status IN ('fetched', 'partial', 'failed')),
          fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_raw_snapshots_business
          ON shopify_raw_snapshots (business_id, fetched_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_raw_snapshots_account
          ON shopify_raw_snapshots (provider_account_id, fetched_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_raw_snapshots_endpoint
          ON shopify_raw_snapshots (endpoint_name, fetched_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_entity_payload_archives (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          shop_id                 TEXT NOT NULL,
          entity_type             TEXT NOT NULL,
          entity_id               TEXT NOT NULL,
          parent_entity_id        TEXT,
          payload_hash            TEXT NOT NULL,
          payload_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_snapshot_id      UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, entity_type, entity_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_entity_payload_archives_business_account
          ON shopify_entity_payload_archives (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_entity_payload_archives_entity
          ON shopify_entity_payload_archives (entity_type, entity_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_shop_dimensions (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          business_ref_id            UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id        TEXT NOT NULL,
          provider_account_ref_id    UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          shop_id                    TEXT NOT NULL,
          shop_domain                TEXT,
          shop_currency_code         TEXT,
          default_order_currency_code TEXT,
          projection_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at              TIMESTAMPTZ,
          last_seen_at               TIMESTAMPTZ,
          source_updated_at          TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_shop_dimensions_business_account
          ON shopify_shop_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_shop_dimensions_shop
          ON shopify_shop_dimensions (shop_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_customer_dimensions (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          business_ref_id            UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id        TEXT NOT NULL,
          provider_account_ref_id    UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          shop_id                    TEXT NOT NULL,
          customer_id                TEXT NOT NULL,
          last_order_id              TEXT,
          projection_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at              TIMESTAMPTZ,
          last_seen_at               TIMESTAMPTZ,
          source_updated_at          TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, customer_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_customer_dimensions_business_account
          ON shopify_customer_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_customer_dimensions_customer
          ON shopify_customer_dimensions (customer_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_product_dimensions (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          business_ref_id            UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id        TEXT NOT NULL,
          provider_account_ref_id    UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          shop_id                    TEXT NOT NULL,
          product_id                 TEXT NOT NULL,
          product_title              TEXT,
          projection_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at              TIMESTAMPTZ,
          last_seen_at               TIMESTAMPTZ,
          source_updated_at          TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, product_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_product_dimensions_business_account
          ON shopify_product_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_product_dimensions_product
          ON shopify_product_dimensions (product_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_variant_dimensions (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          business_ref_id            UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id        TEXT NOT NULL,
          provider_account_ref_id    UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          shop_id                    TEXT NOT NULL,
          product_id                 TEXT,
          variant_id                 TEXT NOT NULL,
          sku                        TEXT,
          product_title              TEXT,
          variant_title              TEXT,
          projection_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at              TIMESTAMPTZ,
          last_seen_at               TIMESTAMPTZ,
          source_updated_at          TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, variant_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_variant_dimensions_business_account
          ON shopify_variant_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_variant_dimensions_variant
          ON shopify_variant_dimensions (variant_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_orders (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id              TEXT NOT NULL,
          provider_account_id      TEXT NOT NULL,
          shop_id                  TEXT NOT NULL,
          order_id                 TEXT NOT NULL,
          order_name               TEXT,
          customer_id              TEXT,
          currency_code            TEXT,
          shop_currency_code       TEXT,
          order_created_at         TIMESTAMPTZ NOT NULL,
          order_created_date_local DATE,
          order_updated_at         TIMESTAMPTZ,
          order_updated_date_local DATE,
          order_processed_at       TIMESTAMPTZ,
          order_cancelled_at       TIMESTAMPTZ,
          order_closed_at          TIMESTAMPTZ,
          financial_status         TEXT,
          fulfillment_status       TEXT,
          customer_journey_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
          subtotal_price           NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_discounts          NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_shipping           NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_tax                NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_refunded           NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_price              NUMERIC(18, 4) NOT NULL DEFAULT 0,
          original_total_price     NUMERIC(18, 4) NOT NULL DEFAULT 0,
          current_total_price      NUMERIC(18, 4) NOT NULL DEFAULT 0,
          source_snapshot_id       UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, order_id)
        )`.catch(() => {}),
        sql`ALTER TABLE shopify_orders
          ADD COLUMN IF NOT EXISTS order_created_date_local DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_orders
          ADD COLUMN IF NOT EXISTS order_updated_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_orders
          ADD COLUMN IF NOT EXISTS order_updated_date_local DATE`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_business_account_created_local
          ON shopify_orders (business_id, provider_account_id, order_created_date_local DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_business_account_created_fallback
          ON shopify_orders (business_id, provider_account_id, (order_created_at::date) DESC)
          WHERE order_created_date_local IS NULL`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_business_created
          ON shopify_orders (business_id, order_created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_business_created_local
          ON shopify_orders (business_id, order_created_date_local DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_business_updated
          ON shopify_orders (business_id, order_updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_shop_created
          ON shopify_orders (shop_id, order_created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_customer
          ON shopify_orders (business_id, customer_id, order_created_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_order_lines (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          order_id             TEXT NOT NULL,
          line_item_id         TEXT NOT NULL,
          product_id           TEXT,
          variant_id           TEXT,
          sku                  TEXT,
          title                TEXT,
          variant_title        TEXT,
          quantity             INTEGER NOT NULL DEFAULT 0,
          discounted_total     NUMERIC(18, 4) NOT NULL DEFAULT 0,
          original_total       NUMERIC(18, 4) NOT NULL DEFAULT 0,
          tax_total            NUMERIC(18, 4) NOT NULL DEFAULT 0,
          source_snapshot_id   UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, order_id, line_item_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_order_lines_business_product
          ON shopify_order_lines (business_id, product_id, variant_id)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_refunds (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          order_id             TEXT NOT NULL,
          refund_id            TEXT NOT NULL,
          refunded_at          TIMESTAMPTZ NOT NULL,
          refunded_date_local  DATE,
          refunded_sales       NUMERIC(18, 4) NOT NULL DEFAULT 0,
          refunded_shipping    NUMERIC(18, 4) NOT NULL DEFAULT 0,
          refunded_taxes       NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_refunded       NUMERIC(18, 4) NOT NULL DEFAULT 0,
          source_snapshot_id   UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, refund_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_refunds_business_refunded
          ON shopify_refunds (business_id, refunded_at DESC)`.catch(() => {}),
        sql`ALTER TABLE shopify_refunds
          ADD COLUMN IF NOT EXISTS refunded_date_local DATE`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_refunds_business_account_refunded_local
          ON shopify_refunds (business_id, provider_account_id, refunded_date_local DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_refunds_business_account_refunded_fallback
          ON shopify_refunds (business_id, provider_account_id, (refunded_at::date) DESC)
          WHERE refunded_date_local IS NULL`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_refunds_business_refunded_local
          ON shopify_refunds (business_id, refunded_date_local DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_order_transactions (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          order_id             TEXT NOT NULL,
          transaction_id       TEXT NOT NULL,
          kind                 TEXT,
          status               TEXT,
          gateway              TEXT,
          processed_at         TIMESTAMPTZ,
          amount               NUMERIC(18, 4) NOT NULL DEFAULT 0,
          currency_code        TEXT,
          source_snapshot_id   UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, transaction_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_order_transactions_business_processed
          ON shopify_order_transactions (business_id, processed_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_returns (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          order_id             TEXT,
          return_id            TEXT NOT NULL,
          status               TEXT,
          created_at_provider  TIMESTAMPTZ NOT NULL,
          created_date_local   DATE,
          updated_at_provider  TIMESTAMPTZ,
          updated_date_local   DATE,
          source_snapshot_id   UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, return_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_returns_business_created
          ON shopify_returns (business_id, created_at_provider DESC)`.catch(() => {}),
        sql`ALTER TABLE shopify_returns
          ADD COLUMN IF NOT EXISTS created_date_local DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_returns
          ADD COLUMN IF NOT EXISTS updated_date_local DATE`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_returns_business_account_created_local
          ON shopify_returns (business_id, provider_account_id, created_date_local DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_returns_business_account_created_fallback
          ON shopify_returns (business_id, provider_account_id, (created_at_provider::date) DESC)
          WHERE created_date_local IS NULL`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_returns_business_created_local
          ON shopify_returns (business_id, created_date_local DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_customer_events (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          event_id             TEXT NOT NULL,
          event_type           TEXT NOT NULL,
          occurred_at          TIMESTAMPTZ NOT NULL,
          customer_id          TEXT,
          session_id           TEXT,
          page_type            TEXT,
          page_url             TEXT,
          consent_state        TEXT,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, event_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_customer_events_business_occurred
          ON shopify_customer_events (business_id, occurred_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_customer_events_session
          ON shopify_customer_events (business_id, session_id, occurred_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_sales_events (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          event_id             TEXT NOT NULL,
          source_kind          TEXT NOT NULL,
          source_id            TEXT NOT NULL,
          order_id             TEXT,
          occurred_at          TIMESTAMPTZ NOT NULL,
          occurred_date_local  DATE,
          gross_sales          NUMERIC(18,2) NOT NULL DEFAULT 0,
          refunded_sales       NUMERIC(18,2) NOT NULL DEFAULT 0,
          refunded_shipping    NUMERIC(18,2) NOT NULL DEFAULT 0,
          refunded_taxes       NUMERIC(18,2) NOT NULL DEFAULT 0,
          net_revenue          NUMERIC(18,2) NOT NULL DEFAULT 0,
          currency_code        TEXT,
          source_snapshot_id   UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, event_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_sales_events_business_date
          ON shopify_sales_events (business_id, occurred_date_local DESC, occurred_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_sales_events_order
          ON shopify_sales_events (business_id, order_id, occurred_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_serving_overrides (
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          override_key         TEXT NOT NULL,
          start_date           DATE,
          end_date             DATE,
          mode                 TEXT NOT NULL DEFAULT 'auto',
          reason               TEXT,
          updated_by           TEXT,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, override_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_serving_overrides_business_range
          ON shopify_serving_overrides (business_id, start_date DESC, end_date DESC, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_webhook_deliveries (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT,
          provider_account_id  TEXT,
          topic                TEXT NOT NULL,
          shop_domain          TEXT NOT NULL,
          webhook_id           TEXT,
          payload_hash         TEXT NOT NULL,
          received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          processed_at         TIMESTAMPTZ,
          processing_state     TEXT NOT NULL DEFAULT 'received',
          error_message        TEXT,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (shop_domain, topic, payload_hash)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_webhook_deliveries_business
          ON shopify_webhook_deliveries (business_id, received_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_reconciliation_runs (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          reconciliation_key   TEXT NOT NULL,
          start_date           DATE,
          end_date             DATE,
          preferred_source     TEXT,
          can_serve_warehouse  BOOLEAN NOT NULL DEFAULT FALSE,
          selected_revenue_truth_basis TEXT,
          basis_selection_reason TEXT,
          transaction_coverage_order_rate DOUBLE PRECISION,
          transaction_coverage_amount_rate DOUBLE PRECISION,
          order_revenue_truth_delta DOUBLE PRECISION,
          transaction_revenue_delta DOUBLE PRECISION,
          explained_adjustment_revenue DOUBLE PRECISION,
          unexplained_adjustment_revenue DOUBLE PRECISION,
          divergence           JSONB,
          warehouse_aggregate  JSONB,
          ledger_aggregate     JSONB,
          live_aggregate       JSONB,
          recorded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_reconciliation_runs_business_recorded
          ON shopify_reconciliation_runs (business_id, recorded_at DESC)`.catch(() => {}),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS selected_revenue_truth_basis TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS basis_selection_reason TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS transaction_coverage_order_rate DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS transaction_coverage_amount_rate DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS order_revenue_truth_delta DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS transaction_revenue_delta DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS explained_adjustment_revenue DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS unexplained_adjustment_revenue DOUBLE PRECISION`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_serving_state (
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          canary_key           TEXT NOT NULL,
          start_date           DATE,
          end_date             DATE,
          time_zone_basis      TEXT,
          assessed_at          TIMESTAMPTZ,
          status_state         TEXT,
          preferred_source     TEXT,
          can_serve_warehouse  BOOLEAN NOT NULL DEFAULT FALSE,
          canary_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
          decision_reasons     JSONB NOT NULL DEFAULT '[]'::jsonb,
          divergence           JSONB,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, canary_key)
        )`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS start_date DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS end_date DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS time_zone_basis TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_recent_synced_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_recent_cursor_timestamp TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_recent_cursor_value TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_recent_synced_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_recent_cursor_timestamp TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_recent_cursor_value TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_historical_synced_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_historical_ready_through_date DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_historical_target_end DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_historical_synced_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_historical_ready_through_date DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_historical_target_end DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS production_mode TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS trust_state TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS fallback_reason TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS coverage_status TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS pending_repair BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS pending_repair_started_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS pending_repair_last_topic TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS pending_repair_last_received_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS consecutive_clean_validations INTEGER NOT NULL DEFAULT 0`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_serving_state_business_updated
          ON shopify_serving_state (business_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_serving_state_business_range
          ON shopify_serving_state (business_id, start_date DESC, end_date DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_serving_state_history (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          canary_key           TEXT NOT NULL,
          start_date           DATE,
          end_date             DATE,
          time_zone_basis      TEXT,
          assessed_at          TIMESTAMPTZ,
          status_state         TEXT,
          preferred_source     TEXT,
          orders_recent_synced_at TIMESTAMPTZ,
          orders_recent_cursor_timestamp TIMESTAMPTZ,
          orders_recent_cursor_value TEXT,
          returns_recent_synced_at TIMESTAMPTZ,
          returns_recent_cursor_timestamp TIMESTAMPTZ,
          returns_recent_cursor_value TEXT,
          orders_historical_synced_at TIMESTAMPTZ,
          orders_historical_ready_through_date DATE,
          orders_historical_target_end DATE,
          returns_historical_synced_at TIMESTAMPTZ,
          returns_historical_ready_through_date DATE,
          returns_historical_target_end DATE,
          can_serve_warehouse  BOOLEAN NOT NULL DEFAULT FALSE,
          canary_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
          decision_reasons     JSONB NOT NULL DEFAULT '[]'::jsonb,
          divergence           JSONB,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_serving_state_history_business_assessed
          ON shopify_serving_state_history (business_id, assessed_at DESC, created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_serving_state_history_business_range
          ON shopify_serving_state_history (business_id, start_date DESC, end_date DESC, assessed_at DESC)`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_recent_synced_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_recent_cursor_timestamp TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_recent_cursor_value TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_recent_synced_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_recent_cursor_timestamp TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_recent_cursor_value TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_historical_synced_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_historical_ready_through_date DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_historical_target_end DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_historical_synced_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_historical_ready_through_date DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_historical_target_end DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS production_mode TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS trust_state TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS fallback_reason TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS coverage_status TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS pending_repair BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS pending_repair_started_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS pending_repair_last_topic TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS pending_repair_last_received_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS consecutive_clean_validations INTEGER NOT NULL DEFAULT 0`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_repair_intents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          event_timestamp TIMESTAMPTZ,
          event_age_days INTEGER,
          escalation_level INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, entity_type, entity_id, topic, payload_hash)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_repair_intents_business_updated
          ON shopify_repair_intents (business_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS shopify_sync_state (
          business_id              TEXT NOT NULL,
          provider_account_id      TEXT NOT NULL,
          sync_target              TEXT NOT NULL,
          historical_target_start  DATE,
          historical_target_end    DATE,
          ready_through_date       DATE,
          cursor_timestamp         TIMESTAMPTZ,
          cursor_value             TEXT,
          latest_sync_started_at   TIMESTAMPTZ,
          latest_successful_sync_at TIMESTAMPTZ,
          latest_sync_status       TEXT,
          latest_sync_window_start DATE,
          latest_sync_window_end   DATE,
          last_error               TEXT,
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, sync_target)
        )`.catch(() => {}),
        sql`ALTER TABLE shopify_sync_state
          ADD COLUMN IF NOT EXISTS cursor_timestamp TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_sync_state
          ADD COLUMN IF NOT EXISTS cursor_value TEXT`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_sync_state_business
          ON shopify_sync_state (business_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS platform_overview_daily_summary (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          date DATE NOT NULL,
          spend NUMERIC(18, 4) NOT NULL DEFAULT 0,
          revenue NUMERIC(18, 4) NOT NULL DEFAULT 0,
          purchases NUMERIC(18, 4) NOT NULL DEFAULT 0,
          impressions BIGINT NOT NULL DEFAULT 0,
          clicks BIGINT NOT NULL DEFAULT 0,
          source_updated_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider, provider_account_id, date)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_platform_overview_daily_summary_business_provider_date
          ON platform_overview_daily_summary (business_id, provider, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_platform_overview_daily_summary_business_account_date
          ON platform_overview_daily_summary (business_id, provider_account_id, date DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS platform_overview_summary_ranges (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          provider_account_ids_hash TEXT NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          row_count INTEGER NOT NULL DEFAULT 0,
          expected_row_count INTEGER,
          coverage_complete BOOLEAN NOT NULL DEFAULT FALSE,
          max_source_updated_at TIMESTAMPTZ,
          truth_state TEXT,
          projection_version INTEGER NOT NULL DEFAULT 1,
          invalidation_reason TEXT,
          hydrated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider, provider_account_ids_hash, start_date, end_date)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_platform_overview_summary_ranges_business_provider
          ON platform_overview_summary_ranges (business_id, provider, hydrated_at DESC)`.catch(() => {}),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS expected_row_count INTEGER`.catch(() => {}),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS coverage_complete BOOLEAN NOT NULL DEFAULT FALSE`.catch(() => {}),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS max_source_updated_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS truth_state TEXT`.catch(() => {}),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS projection_version INTEGER NOT NULL DEFAULT 1`.catch(() => {}),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS invalidation_reason TEXT`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS platform_overview_summary_range_accounts (
          summary_range_id UUID NOT NULL REFERENCES platform_overview_summary_ranges(id) ON DELETE CASCADE,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          provider_account_id TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (summary_range_id, provider_account_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_platform_overview_summary_range_accounts_range
          ON platform_overview_summary_range_accounts (summary_range_id, position ASC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_platform_overview_summary_range_accounts_provider_account_ref
          ON platform_overview_summary_range_accounts (provider_account_ref_id)`.catch(() => {}),
      ]);

      // ── Engine v3 pre-computed analytics tables (schema only) ─────────────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS engine_v3_job_runs (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          job_name                   TEXT NOT NULL,
          business_ref_id            UUID NOT NULL,
          business_id                TEXT,
          as_of_date                 DATE NOT NULL,
          engine_version             TEXT NOT NULL,
          status                     TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
          dependency_run_id          UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at                TIMESTAMPTZ,
          duration_ms                INTEGER,
          row_count                  INTEGER,
          source_min_date            DATE,
          source_max_date            DATE,
          source_max_updated_at      TIMESTAMPTZ,
          input_hash                 TEXT,
          retry_count                INTEGER NOT NULL DEFAULT 0,
          error_code                 TEXT,
          error_message              TEXT,
          error_json                 JSONB,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_job_runs_lookup
          ON engine_v3_job_runs (job_name, business_ref_id, as_of_date DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_job_runs_status
          ON engine_v3_job_runs (status, started_at DESC)
          WHERE status IN ('running', 'failed')`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_job_runs_business_recent
          ON engine_v3_job_runs (business_ref_id, started_at DESC)`,
        sql`CREATE TABLE IF NOT EXISTS engine_v3_account_calibration_daily (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_ref_id            UUID NOT NULL,
          business_id                TEXT,
          scope_type                 TEXT NOT NULL DEFAULT 'account',
          scope_id                   TEXT NOT NULL DEFAULT '*',
          as_of_date                 DATE NOT NULL,
          engine_version             TEXT NOT NULL,
          sample_window_start        DATE NOT NULL,
          sample_window_end          DATE NOT NULL,
          sample_window_days         INTEGER NOT NULL,
          eligible_creative_count    INTEGER NOT NULL DEFAULT 0,
          mature_creative_count      INTEGER NOT NULL DEFAULT 0,
          zero_conversion_count      INTEGER NOT NULL DEFAULT 0,
          roas_p75                   DOUBLE PRECISION,
          roas_p60                   DOUBLE PRECISION,
          refresh_ratio_p10          DOUBLE PRECISION,
          low_ctr_p10                DOUBLE PRECISION,
          account_cpa_p50            DOUBLE PRECISION,
          account_cpa_sample_count   INTEGER NOT NULL DEFAULT 0,
          meta_attributed_aov_mean_90d DOUBLE PRECISION,
          meta_attributed_aov_purchase_count_90d INTEGER NOT NULL DEFAULT 0,
          meta_attributed_revenue_90d DOUBLE PRECISION,
          meta_aov_quality           TEXT
                                      CHECK (meta_aov_quality IN ('unavailable', 'unstable', 'low_sample', 'ready')),
          mature_spend_p50           DOUBLE PRECISION,
          mature_spend_p75           DOUBLE PRECISION,
          winner_spend_p25           DOUBLE PRECISION,
          winner_spend_p50           DOUBLE PRECISION,
          winner_purchase_p50        DOUBLE PRECISION,
          roas_ratio_p10             DOUBLE PRECISION,
          roas_ratio_p25             DOUBLE PRECISION,
          roas_ratio_p50             DOUBLE PRECISION,
          roas_ratio_p75             DOUBLE PRECISION,
          source_min_date            DATE,
          source_max_date            DATE,
          source_max_updated_at      TIMESTAMPTZ,
          quality_status             TEXT NOT NULL DEFAULT 'ready' CHECK (quality_status IN ('ready', 'low_sample', 'stale', 'fallback')),
          job_run_id                 UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          input_hash                 TEXT,
          computed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_ref_id, scope_type, scope_id, as_of_date, engine_version)
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_calibration_latest
          ON engine_v3_account_calibration_daily
          (business_ref_id, scope_type, scope_id, as_of_date DESC)
          INCLUDE (roas_p75, roas_p60, refresh_ratio_p10, low_ctr_p10, quality_status, source_max_date)`,
        sql`ALTER TABLE engine_v3_account_calibration_daily
          ADD COLUMN IF NOT EXISTS account_cpa_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS account_cpa_sample_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS meta_attributed_aov_mean_90d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS meta_attributed_aov_purchase_count_90d INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS meta_attributed_revenue_90d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS meta_aov_quality TEXT
            CHECK (meta_aov_quality IN ('unavailable', 'unstable', 'low_sample', 'ready')),
          ADD COLUMN IF NOT EXISTS mature_spend_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS mature_spend_p75 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS winner_spend_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS winner_spend_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS winner_purchase_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS roas_ratio_p10 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS roas_ratio_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS roas_ratio_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS roas_ratio_p75 DOUBLE PRECISION`.catch(() => {}),
        sql`ALTER TABLE engine_v3_account_calibration_daily
          ADD COLUMN IF NOT EXISTS creative_format TEXT NOT NULL DEFAULT 'overall',
          ADD COLUMN IF NOT EXISTS ctr_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS ctr_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS cpm_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS cpm_p75 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS thumbstop_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS thumbstop_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_lpv_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_lpv_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_atc_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_atc_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS lpv_to_atc_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS lpv_to_atc_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS atc_to_ic_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS atc_to_ic_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS ic_to_purchase_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS ic_to_purchase_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS click_to_purchase_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS click_to_purchase_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS funnel_sample_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS funnel_quality_status TEXT
            CHECK (funnel_quality_status IN ('ready', 'low_sample', 'insufficient'))`.catch(() => {}),
        sql`DO $$
          DECLARE
            old_constraint_name TEXT;
          BEGIN
            SELECT c.conname
            INTO old_constraint_name
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = current_schema()
              AND t.relname = 'engine_v3_account_calibration_daily'
              AND c.contype = 'u'
              AND (
                SELECT array_agg(a.attname::text ORDER BY u.ord)
                FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
              ) = ARRAY['business_ref_id', 'scope_type', 'scope_id', 'as_of_date', 'engine_version']
            LIMIT 1;

            IF old_constraint_name IS NOT NULL THEN
              EXECUTE format(
                'ALTER TABLE engine_v3_account_calibration_daily DROP CONSTRAINT %I',
                old_constraint_name
              );
            END IF;

            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = current_schema()
                AND t.relname = 'engine_v3_account_calibration_daily'
                AND c.contype = 'u'
                AND (
                  SELECT array_agg(a.attname::text ORDER BY u.ord)
                  FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
                ) = ARRAY[
                  'business_ref_id',
                  'scope_type',
                  'scope_id',
                  'creative_format',
                  'as_of_date',
                  'engine_version'
                ]
            ) THEN
              ALTER TABLE engine_v3_account_calibration_daily
                ADD CONSTRAINT engine_v3_account_calibration_daily_format_unique
                UNIQUE (business_ref_id, scope_type, scope_id, creative_format, as_of_date, engine_version);
            END IF;
          END
          $$`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS engine_v3_creative_lifecycle_daily (
          id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_ref_id               UUID NOT NULL,
          business_id                   TEXT,
          provider_account_ref_id       UUID,
          provider_account_id           TEXT,
          campaign_id                   TEXT,
          adset_id                      TEXT,
          ad_id                         TEXT,
          creative_id                   TEXT NOT NULL,
          effective_object_story_id     TEXT,
          post_id                       TEXT,
          creative_identity_hash        TEXT,
          as_of_date                    DATE NOT NULL,
          engine_version                TEXT NOT NULL,
          spend_28d                     DOUBLE PRECISION,
          purchases_28d                 DOUBLE PRECISION,
          purchase_value_28d            DOUBLE PRECISION,
          impressions_28d               BIGINT,
          link_clicks_28d               BIGINT,
          roas_28d                      DOUBLE PRECISION,
          cpa_28d                       DOUBLE PRECISION,
          ctr_28d                       DOUBLE PRECISION,
          frequency_28d                 DOUBLE PRECISION,
          spend_7d                      DOUBLE PRECISION,
          purchases_7d                  DOUBLE PRECISION,
          roas_7d                       DOUBLE PRECISION,
          impressions_7d                BIGINT,
          first_seen_date               DATE,
          last_active_date              DATE,
          active_days_30d               INTEGER,
          age_days                      INTEGER,
          peak_roas_30d                 DOUBLE PRECISION,
          peak_roas_date                DATE,
          days_since_peak               INTEGER,
          peak_confidence               DOUBLE PRECISION,
          peak_spend_30d                DOUBLE PRECISION,
          peak_purchases_30d            DOUBLE PRECISION,
          spend_slope_7d                DOUBLE PRECISION,
          spend_slope_30d               DOUBLE PRECISION,
          roas_slope_7d                 DOUBLE PRECISION,
          roas_slope_30d                DOUBLE PRECISION,
          spend_trajectory_30d          TEXT CHECK (spend_trajectory_30d IN ('rising', 'flat', 'falling', 'volatile', 'unknown')),
          lifecycle_position            TEXT CHECK (lifecycle_position IN (
            'rising', 'plateau', 'closing',
            'past_peak_inaction', 'past_peak_natural', 'past_peak_unclear',
            'volatile', 'insufficient_history'
          )),
          fatigue_status                TEXT CHECK (fatigue_status IN ('none', 'watch', 'fatigued', 'unknown')),
          fatigue_confidence            DOUBLE PRECISION,
          fatigue_evidence              JSONB,
          decision_recommended_at       TIMESTAMPTZ,
          operator_response_detected_at TIMESTAMPTZ,
          operator_response_type        TEXT CHECK (operator_response_type IN (
            'scaled', 'ignored', 'paused', 'creative_archived', 'budget_cut', 'unknown'
          )),
          effective_status              TEXT,
          objective                      TEXT,
          target_roas                   DOUBLE PRECISION,
          breakeven_roas                DOUBLE PRECISION,
          data_freshness_hours          INTEGER,
          source_max_date               DATE,
          source_max_updated_at         TIMESTAMPTZ,
          eligible_for_lifecycle        BOOLEAN NOT NULL DEFAULT true,
          job_run_id                    UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          input_hash                    TEXT,
          computed_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_ref_id, creative_id, as_of_date, engine_version)
        )`,
        sql`ALTER TABLE engine_v3_creative_lifecycle_daily
          ADD COLUMN IF NOT EXISTS cpm_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS outbound_clicks_28d INTEGER,
          ADD COLUMN IF NOT EXISTS landing_page_views_28d INTEGER,
          ADD COLUMN IF NOT EXISTS add_to_cart_28d INTEGER,
          ADD COLUMN IF NOT EXISTS initiate_checkout_28d INTEGER,
          ADD COLUMN IF NOT EXISTS thumbstop_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS video25_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS video50_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS video75_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS video100_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS quality_ranking TEXT,
          ADD COLUMN IF NOT EXISTS engagement_rate_ranking TEXT,
          ADD COLUMN IF NOT EXISTS conversion_rate_ranking TEXT,
          ADD COLUMN IF NOT EXISTS creative_format TEXT,
          ADD COLUMN IF NOT EXISTS outbound_click_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_lpv_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_atc_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS lpv_to_atc_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS atc_to_ic_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS ic_to_purchase_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS atc_to_purchase_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS click_to_purchase_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS funnel_primary_weak_stage TEXT
            CHECK (funnel_primary_weak_stage IN ('upper_funnel', 'landing_page', 'checkout', 'tracking', 'none', 'insufficient_signal')),
          ADD COLUMN IF NOT EXISTS funnel_confidence DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS funnel_evidence JSONB,
          ADD COLUMN IF NOT EXISTS creative_responsibility_score DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS site_responsibility_score DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS checkout_responsibility_score DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS tracking_anomaly_score DOUBLE PRECISION`.catch(() => {}),
        sql`DO $$
          DECLARE
            old_constraint_name TEXT;
          BEGIN
            SELECT c.conname
            INTO old_constraint_name
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = current_schema()
              AND t.relname = 'engine_v3_creative_lifecycle_daily'
              AND c.contype = 'c'
              AND pg_get_constraintdef(c.oid) LIKE '%operator_response_type%'
              AND pg_get_constraintdef(c.oid) NOT LIKE '%creative_archived%'
            LIMIT 1;

            IF old_constraint_name IS NOT NULL THEN
              EXECUTE format(
                'ALTER TABLE engine_v3_creative_lifecycle_daily DROP CONSTRAINT %I',
                old_constraint_name
              );
            END IF;

            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = current_schema()
                AND t.relname = 'engine_v3_creative_lifecycle_daily'
                AND c.contype = 'c'
                AND pg_get_constraintdef(c.oid) LIKE '%operator_response_type%'
                AND pg_get_constraintdef(c.oid) LIKE '%creative_archived%'
            ) THEN
              ALTER TABLE engine_v3_creative_lifecycle_daily
                ADD CONSTRAINT engine_v3_creative_lifecycle_daily_operator_response_type_check
                CHECK (operator_response_type IN (
                  'scaled', 'ignored', 'paused', 'creative_archived', 'budget_cut', 'unknown'
                ));
            END IF;
          END
          $$`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_lifecycle_business_day
          ON engine_v3_creative_lifecycle_daily
          (business_ref_id, as_of_date DESC, creative_id)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_lifecycle_creative_timeline
          ON engine_v3_creative_lifecycle_daily
          (business_ref_id, creative_id, as_of_date DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_lifecycle_attention
          ON engine_v3_creative_lifecycle_daily
          (business_ref_id, as_of_date DESC, lifecycle_position)
          WHERE lifecycle_position IN ('rising', 'plateau', 'past_peak_inaction', 'past_peak_unclear')`,
        sql`CREATE TABLE IF NOT EXISTS engine_v3_decision_snapshots_daily (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_ref_id            UUID NOT NULL,
          business_id                TEXT,
          creative_id                TEXT NOT NULL,
          as_of_date                 DATE NOT NULL,
          engine_version             TEXT NOT NULL,
          label                      TEXT NOT NULL CHECK (label IN (
            'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
          )),
          confidence                 INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
          truth_source               TEXT NOT NULL CHECK (truth_source IN (
            'commercial_truth', 'account_baseline', 'account_baseline_thin', 'global_default'
          )),
          effective_target_roas      DOUBLE PRECISION NOT NULL,
          ratio_to_target            DOUBLE PRECISION,
          badges                     JSONB NOT NULL DEFAULT '[]'::jsonb,
          reason                     TEXT NOT NULL,
          spend                      DOUBLE PRECISION,
          purchases                  DOUBLE PRECISION,
          roas                       DOUBLE PRECISION,
          recent7d_roas              DOUBLE PRECISION,
          job_run_id                 UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          lifecycle_row_id           UUID REFERENCES engine_v3_creative_lifecycle_daily(id) ON DELETE SET NULL,
          calibration_row_id         UUID REFERENCES engine_v3_account_calibration_daily(id) ON DELETE SET NULL,
          input_hash                 TEXT,
          computed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_ref_id, creative_id, as_of_date, engine_version)
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_decisions_business_day_label
          ON engine_v3_decision_snapshots_daily
          (business_ref_id, as_of_date DESC, label)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_decisions_creative_timeline
          ON engine_v3_decision_snapshots_daily
          (business_ref_id, creative_id, as_of_date DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_decisions_first_scale
          ON engine_v3_decision_snapshots_daily
          (business_ref_id, creative_id, as_of_date)
          WHERE label = 'scale'`,
        sql`CREATE TABLE IF NOT EXISTS engine_v3_decision_events (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_ref_id            UUID NOT NULL,
          business_id                TEXT,
          creative_id                TEXT NOT NULL,
          event_date                 DATE NOT NULL,
          event_type                 TEXT NOT NULL CHECK (event_type IN (
            'decision_changed',
            'operator_action',
            'data_disabled',
            'manual_override'
          )),
          previous_label             TEXT,
          current_label              TEXT,
          previous_confidence        INTEGER,
          current_confidence         INTEGER,
          operator_action_type       TEXT CHECK (operator_action_type IN (
            'scaled', 'paused', 'budget_increased', 'budget_decreased', 'creative_archived', 'unknown'
          )),
          operator_evidence          JSONB,
          decision_snapshot_id       UUID REFERENCES engine_v3_decision_snapshots_daily(id) ON DELETE SET NULL,
          job_run_id                 UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          notes                      TEXT,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_events_business_date
          ON engine_v3_decision_events
          (business_ref_id, event_date DESC, event_type)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_events_creative_timeline
          ON engine_v3_decision_events
          (business_ref_id, creative_id, event_date DESC)`,
      ]);

      // ── Engine v3 rollout feature flags (NULL = inherit env default) ─────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS business_engine_v3_flags (
          business_id     UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
          enabled         BOOLEAN NULL,
          surface_visible BOOLEAN NULL,
          shadow_only     BOOLEAN NULL,
          notes           TEXT NULL,
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by      TEXT NULL
        )`,
        sql`ALTER TABLE business_engine_v3_flags
          ADD COLUMN IF NOT EXISTS enabled BOOLEAN NULL,
          ADD COLUMN IF NOT EXISTS surface_visible BOOLEAN NULL,
          ADD COLUMN IF NOT EXISTS shadow_only BOOLEAN NULL,
          ADD COLUMN IF NOT EXISTS notes TEXT NULL,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ADD COLUMN IF NOT EXISTS updated_by TEXT NULL`.catch(() => {}),
      ]);

      await runMigrationBatchSequentially([
        ...CANONICAL_BUSINESS_REF_TABLES.map((tableName) =>
          sql.query(
            `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS business_ref_id UUID REFERENCES businesses(id) ON DELETE SET NULL`,
          ).catch(() => {}),
        ),
        ...CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql.query(
            `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL`,
          ).catch(() => {}),
        ),
      ]);

      await runMigrationBatchSequentially([
        sql.query(
          `
            INSERT INTO provider_accounts (
              provider,
              external_account_id,
              created_at,
              updated_at
            )
            SELECT
              'meta',
              seed.external_account_id,
              now(),
              now()
            FROM (
              ${buildProviderAccountSeedUnionQuery(META_PROVIDER_ACCOUNT_SEED_TABLES, "provider_account_id")}
              UNION
              ${buildProviderAccountSeedUnionQuery(META_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES, "account_id")}
            ) AS seed
            WHERE seed.external_account_id IS NOT NULL
            ON CONFLICT (provider, external_account_id) DO UPDATE SET
              updated_at = EXCLUDED.updated_at
          `,
        ).catch(() => {}),
        sql.query(
          `
            INSERT INTO provider_accounts (
              provider,
              external_account_id,
              created_at,
              updated_at
            )
            SELECT
              'google',
              seed.external_account_id,
              now(),
              now()
            FROM (
              ${buildProviderAccountSeedUnionQuery(GOOGLE_PROVIDER_ACCOUNT_SEED_TABLES, "provider_account_id")}
              UNION
              ${buildProviderAccountSeedUnionQuery(GOOGLE_ADS_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES, "account_id")}
            ) AS seed
            WHERE seed.external_account_id IS NOT NULL
            ON CONFLICT (provider, external_account_id) DO UPDATE SET
              updated_at = EXCLUDED.updated_at
          `,
        ).catch(() => {}),
        sql.query(
          `
            INSERT INTO provider_accounts (
              provider,
              external_account_id,
              created_at,
              updated_at
            )
            SELECT
              'shopify',
              seed.external_account_id,
              now(),
              now()
            FROM (
              ${buildProviderAccountSeedUnionQuery(SHOPIFY_PROVIDER_ACCOUNT_SEED_TABLES, "provider_account_id")}
            ) AS seed
            WHERE seed.external_account_id IS NOT NULL
            ON CONFLICT (provider, external_account_id) DO UPDATE SET
              updated_at = EXCLUDED.updated_at
          `,
        ).catch(() => {}),
        ...CANONICAL_BUSINESS_REF_TABLES.map((tableName) =>
          sql.query(
            `
              UPDATE ${tableName} AS target
              SET business_ref_id = business.id
              FROM businesses AS business
              WHERE target.business_ref_id IS NULL
                AND business.id::text = target.business_id
            `,
          ).catch(() => {}),
        ),
        ...META_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql.query(
            `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'meta'
                AND provider_account.external_account_id = target.provider_account_id
            `,
          ).catch(() => {}),
        ),
        ...GOOGLE_ADS_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql.query(
            `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'google'
                AND provider_account.external_account_id = target.provider_account_id
            `,
          ).catch(() => {}),
        ),
        ...SHOPIFY_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql.query(
            `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'shopify'
                AND provider_account.external_account_id = target.provider_account_id
            `,
          ).catch(() => {}),
        ),
        ...META_AUTHORITATIVE_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql.query(
            `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'meta'
                AND provider_account.external_account_id = target.provider_account_id
            `,
          ).catch(() => {}),
        ),
        ...META_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql.query(
            `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'meta'
                AND provider_account.external_account_id = target.account_id
            `,
          ).catch(() => {}),
        ),
        ...GOOGLE_ADS_SEARCH_INTELLIGENCE_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql.query(
            `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'google'
                AND provider_account.external_account_id = target.provider_account_id
            `,
          ).catch(() => {}),
        ),
        ...GOOGLE_ADS_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql.query(
            `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'google'
                AND provider_account.external_account_id = target.account_id
            `,
          ).catch(() => {}),
        ),
        ...SHOPIFY_CONTROL_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql.query(
            `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'shopify'
                AND provider_account.external_account_id = target.provider_account_id
            `,
          ).catch(() => {}),
        ),
        ...GENERIC_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql.query(
            `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = CASE
                  WHEN target.provider = 'google_ads' THEN 'google'
                  ELSE target.provider
                END
                AND provider_account.external_account_id = target.provider_account_id
            `,
          ).catch(() => {}),
        ),
        sql.query(
          `
            UPDATE platform_overview_daily_summary AS target
            SET provider_account_ref_id = provider_account.id
            FROM provider_accounts AS provider_account
            WHERE target.provider_account_ref_id IS NULL
              AND provider_account.provider = target.provider
              AND provider_account.external_account_id = target.provider_account_id
          `,
        ).catch(() => {}),
      ]);

      await runMigrationBatchSequentially([
        sql.query(
          `
            WITH source_rows AS (
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'order'::text AS entity_type,
                order_id AS entity_id,
                NULL::text AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                COALESCE(order_updated_at, order_created_at, updated_at) AS source_updated_at
              FROM shopify_orders
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'order_line'::text AS entity_type,
                line_item_id AS entity_id,
                order_id AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                updated_at AS source_updated_at
              FROM shopify_order_lines
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'refund'::text AS entity_type,
                refund_id AS entity_id,
                order_id AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                COALESCE(refunded_at, updated_at) AS source_updated_at
              FROM shopify_refunds
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'transaction'::text AS entity_type,
                transaction_id AS entity_id,
                order_id AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                COALESCE(processed_at, updated_at) AS source_updated_at
              FROM shopify_order_transactions
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'return'::text AS entity_type,
                return_id AS entity_id,
                order_id AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                COALESCE(updated_at_provider, created_at_provider, updated_at) AS source_updated_at
              FROM shopify_returns
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'sales_event'::text AS entity_type,
                event_id AS entity_id,
                COALESCE(order_id, source_id) AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                COALESCE(occurred_at, updated_at) AS source_updated_at
              FROM shopify_sales_events
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'customer_event'::text AS entity_type,
                event_id AS entity_id,
                customer_id AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                NULL::uuid AS source_snapshot_id,
                COALESCE(occurred_at, updated_at) AS source_updated_at
              FROM shopify_customer_events
              WHERE payload_json <> '{}'::jsonb
            )
            INSERT INTO shopify_entity_payload_archives (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              entity_type,
              entity_id,
              parent_entity_id,
              payload_hash,
              payload_json,
              source_snapshot_id,
              source_updated_at,
              updated_at
            )
            SELECT
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              entity_type,
              entity_id,
              parent_entity_id,
              payload_hash,
              payload_json,
              source_snapshot_id,
              source_updated_at,
              now()
            FROM source_rows
            ON CONFLICT (business_id, provider_account_id, shop_id, entity_type, entity_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_entity_payload_archives.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_entity_payload_archives.provider_account_ref_id),
              parent_entity_id = COALESCE(EXCLUDED.parent_entity_id, shopify_entity_payload_archives.parent_entity_id),
              payload_hash = EXCLUDED.payload_hash,
              payload_json = EXCLUDED.payload_json,
              source_snapshot_id = COALESCE(EXCLUDED.source_snapshot_id, shopify_entity_payload_archives.source_snapshot_id),
              source_updated_at = GREATEST(COALESCE(shopify_entity_payload_archives.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
      ]);

      await runMigrationBatchSequentially([
        sql`ALTER TABLE shopify_orders
          DROP COLUMN IF EXISTS payload_json`.catch(() => {}),
        sql`ALTER TABLE shopify_order_lines
          DROP COLUMN IF EXISTS payload_json`.catch(() => {}),
        sql`ALTER TABLE shopify_refunds
          DROP COLUMN IF EXISTS payload_json`.catch(() => {}),
        sql`ALTER TABLE shopify_order_transactions
          DROP COLUMN IF EXISTS payload_json`.catch(() => {}),
        sql`ALTER TABLE shopify_returns
          DROP COLUMN IF EXISTS payload_json`.catch(() => {}),
        sql`ALTER TABLE shopify_sales_events
          DROP COLUMN IF EXISTS payload_json`.catch(() => {}),
        sql`ALTER TABLE shopify_customer_events
          DROP COLUMN IF EXISTS payload_json`.catch(() => {}),
        sql`ALTER TABLE shopify_webhook_deliveries
          DROP COLUMN IF EXISTS payload_json`.catch(() => {}),
        sql`ALTER TABLE shopify_webhook_deliveries
          DROP COLUMN IF EXISTS result_summary`.catch(() => {}),
        sql`ALTER TABLE shopify_repair_intents
          DROP COLUMN IF EXISTS last_sync_result`.catch(() => {}),
        sql`ALTER TABLE shopify_sync_state
          DROP COLUMN IF EXISTS last_result_summary`.catch(() => {}),
      ]);

      await runMigrationBatchSequentially([
        sql.query(
          `
            WITH source_rows AS (
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                provider_account_id AS shop_id,
                'webhook_delivery'::text AS entity_type,
                shop_domain || '::' || topic || '::' || payload_hash AS entity_id,
                webhook_id AS parent_entity_id,
                payload_hash,
                jsonb_strip_nulls(
                  jsonb_build_object(
                    'payload',
                    CASE
                      WHEN payload_json <> '{}'::jsonb THEN payload_json
                      ELSE NULL
                    END,
                    'resultSummary',
                    result_summary
                  )
                ) AS payload_json,
                NULL::uuid AS source_snapshot_id,
                COALESCE(processed_at, received_at, updated_at, created_at) AS source_updated_at
              FROM shopify_webhook_deliveries
              WHERE business_id IS NOT NULL
                AND provider_account_id IS NOT NULL
                AND (payload_json <> '{}'::jsonb OR result_summary IS NOT NULL)
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                provider_account_id AS shop_id,
                'repair_intent_state'::text AS entity_type,
                id::text AS entity_id,
                entity_id AS parent_entity_id,
                payload_hash,
                jsonb_build_object('lastSyncResult', last_sync_result) AS payload_json,
                NULL::uuid AS source_snapshot_id,
                updated_at AS source_updated_at
              FROM shopify_repair_intents
              WHERE last_sync_result IS NOT NULL
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                provider_account_id AS shop_id,
                'sync_state_detail'::text AS entity_type,
                sync_target AS entity_id,
                NULL::text AS parent_entity_id,
                md5(last_result_summary::text) AS payload_hash,
                jsonb_build_object('lastResultSummary', last_result_summary) AS payload_json,
                NULL::uuid AS source_snapshot_id,
                COALESCE(latest_successful_sync_at, latest_sync_started_at, updated_at) AS source_updated_at
              FROM shopify_sync_state
              WHERE last_result_summary IS NOT NULL
            )
            INSERT INTO shopify_entity_payload_archives (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              entity_type,
              entity_id,
              parent_entity_id,
              payload_hash,
              payload_json,
              source_snapshot_id,
              source_updated_at,
              updated_at
            )
            SELECT
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              entity_type,
              entity_id,
              parent_entity_id,
              payload_hash,
              payload_json,
              source_snapshot_id,
              source_updated_at,
              now()
            FROM source_rows
            WHERE payload_json <> '{}'::jsonb
            ON CONFLICT (business_id, provider_account_id, shop_id, entity_type, entity_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_entity_payload_archives.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_entity_payload_archives.provider_account_ref_id),
              parent_entity_id = COALESCE(EXCLUDED.parent_entity_id, shopify_entity_payload_archives.parent_entity_id),
              payload_hash = EXCLUDED.payload_hash,
              payload_json = EXCLUDED.payload_json,
              source_updated_at = GREATEST(COALESCE(shopify_entity_payload_archives.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
      ]);

      await runMigrationBatchSequentially([
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                shop_id,
                MIN(order_created_at) AS first_seen_at,
                MAX(COALESCE(order_updated_at, order_created_at)) AS last_seen_at
              FROM shopify_orders
              WHERE NULLIF(TRIM(shop_id), '') IS NOT NULL
              GROUP BY business_id, provider_account_id, shop_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, shop_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                provider_account_id AS shop_domain,
                shop_currency_code,
                currency_code AS default_order_currency_code,
                COALESCE(order_updated_at, order_created_at) AS source_updated_at
              FROM shopify_orders
              WHERE NULLIF(TRIM(shop_id), '') IS NOT NULL
              ORDER BY
                business_id,
                provider_account_id,
                shop_id,
                COALESCE(order_updated_at, order_created_at) DESC NULLS LAST,
                order_created_at DESC,
                updated_at DESC
            )
            INSERT INTO shopify_shop_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              shop_domain,
              shop_currency_code,
              default_order_currency_code,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.shop_id,
              latest.shop_domain,
              latest.shop_currency_code,
              latest.default_order_currency_code,
              '{}'::jsonb,
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.source_updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.shop_id = latest.shop_id
            ON CONFLICT (business_id, provider_account_id, shop_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_shop_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_shop_dimensions.provider_account_ref_id),
              shop_domain = COALESCE(EXCLUDED.shop_domain, shopify_shop_dimensions.shop_domain),
              shop_currency_code = COALESCE(EXCLUDED.shop_currency_code, shopify_shop_dimensions.shop_currency_code),
              default_order_currency_code = COALESCE(EXCLUDED.default_order_currency_code, shopify_shop_dimensions.default_order_currency_code),
              projection_json = CASE
                WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_shop_dimensions.projection_json
                ELSE EXCLUDED.projection_json
              END,
              first_seen_at = COALESCE(shopify_shop_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(shopify_shop_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(shopify_shop_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                shop_id,
                customer_id,
                MIN(order_created_at) AS first_seen_at,
                MAX(COALESCE(order_updated_at, order_created_at)) AS last_seen_at
              FROM shopify_orders
              WHERE NULLIF(TRIM(customer_id), '') IS NOT NULL
              GROUP BY business_id, provider_account_id, shop_id, customer_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, shop_id, customer_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                customer_id,
                order_id AS last_order_id,
                COALESCE(order_updated_at, order_created_at) AS source_updated_at
              FROM shopify_orders
              WHERE NULLIF(TRIM(customer_id), '') IS NOT NULL
              ORDER BY
                business_id,
                provider_account_id,
                shop_id,
                customer_id,
                COALESCE(order_updated_at, order_created_at) DESC NULLS LAST,
                order_created_at DESC,
                updated_at DESC
            )
            INSERT INTO shopify_customer_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              customer_id,
              last_order_id,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.shop_id,
              latest.customer_id,
              latest.last_order_id,
              '{}'::jsonb,
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.source_updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.shop_id = latest.shop_id
             AND bounds.customer_id = latest.customer_id
            ON CONFLICT (business_id, provider_account_id, shop_id, customer_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_customer_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_customer_dimensions.provider_account_ref_id),
              last_order_id = COALESCE(EXCLUDED.last_order_id, shopify_customer_dimensions.last_order_id),
              projection_json = CASE
                WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_customer_dimensions.projection_json
                ELSE EXCLUDED.projection_json
              END,
              first_seen_at = COALESCE(shopify_customer_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(shopify_customer_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(shopify_customer_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH source_rows AS (
              SELECT
                line.business_id,
                line.business_ref_id,
                line.provider_account_id,
                line.provider_account_ref_id,
                line.shop_id,
                line.product_id,
                NULLIF(TRIM(line.title), '') AS product_title,
                NULLIF(TRIM(line.sku), '') AS sku,
                NULLIF(TRIM(line.variant_title), '') AS variant_title,
                COALESCE(order_row.order_created_at, order_row.order_updated_at, line.updated_at) AS first_seen_candidate,
                COALESCE(order_row.order_updated_at, order_row.order_created_at, line.updated_at) AS source_updated_at,
                line.updated_at
              FROM shopify_order_lines AS line
              LEFT JOIN shopify_orders AS order_row
                ON order_row.business_id = line.business_id
               AND order_row.provider_account_id = line.provider_account_id
               AND order_row.shop_id = line.shop_id
               AND order_row.order_id = line.order_id
              WHERE NULLIF(TRIM(line.product_id), '') IS NOT NULL
            ),
            bounds AS (
              SELECT
                business_id,
                provider_account_id,
                shop_id,
                product_id,
                MIN(first_seen_candidate) AS first_seen_at,
                MAX(source_updated_at) AS last_seen_at
              FROM source_rows
              GROUP BY business_id, provider_account_id, shop_id, product_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, shop_id, product_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                product_id,
                product_title,
                sku,
                variant_title,
                source_updated_at
              FROM source_rows
              ORDER BY
                business_id,
                provider_account_id,
                shop_id,
                product_id,
                source_updated_at DESC NULLS LAST,
                updated_at DESC
            )
            INSERT INTO shopify_product_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              product_id,
              product_title,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.shop_id,
              latest.product_id,
              latest.product_title,
              jsonb_strip_nulls(jsonb_build_object(
                'sku', latest.sku,
                'variantTitle', latest.variant_title
              )),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.source_updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.shop_id = latest.shop_id
             AND bounds.product_id = latest.product_id
            ON CONFLICT (business_id, provider_account_id, shop_id, product_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_product_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_product_dimensions.provider_account_ref_id),
              product_title = COALESCE(EXCLUDED.product_title, shopify_product_dimensions.product_title),
              projection_json = CASE
                WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_product_dimensions.projection_json
                ELSE EXCLUDED.projection_json
              END,
              first_seen_at = COALESCE(shopify_product_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(shopify_product_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(shopify_product_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH source_rows AS (
              SELECT
                line.business_id,
                line.business_ref_id,
                line.provider_account_id,
                line.provider_account_ref_id,
                line.shop_id,
                line.product_id,
                line.variant_id,
                NULLIF(TRIM(line.sku), '') AS sku,
                NULLIF(TRIM(line.title), '') AS product_title,
                NULLIF(TRIM(line.variant_title), '') AS variant_title,
                COALESCE(order_row.order_created_at, order_row.order_updated_at, line.updated_at) AS first_seen_candidate,
                COALESCE(order_row.order_updated_at, order_row.order_created_at, line.updated_at) AS source_updated_at,
                line.updated_at
              FROM shopify_order_lines AS line
              LEFT JOIN shopify_orders AS order_row
                ON order_row.business_id = line.business_id
               AND order_row.provider_account_id = line.provider_account_id
               AND order_row.shop_id = line.shop_id
               AND order_row.order_id = line.order_id
              WHERE NULLIF(TRIM(line.variant_id), '') IS NOT NULL
            ),
            bounds AS (
              SELECT
                business_id,
                provider_account_id,
                shop_id,
                variant_id,
                MIN(first_seen_candidate) AS first_seen_at,
                MAX(source_updated_at) AS last_seen_at
              FROM source_rows
              GROUP BY business_id, provider_account_id, shop_id, variant_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, shop_id, variant_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                product_id,
                variant_id,
                sku,
                product_title,
                variant_title,
                source_updated_at
              FROM source_rows
              ORDER BY
                business_id,
                provider_account_id,
                shop_id,
                variant_id,
                source_updated_at DESC NULLS LAST,
                updated_at DESC
            )
            INSERT INTO shopify_variant_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              product_id,
              variant_id,
              sku,
              product_title,
              variant_title,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.shop_id,
              latest.product_id,
              latest.variant_id,
              latest.sku,
              latest.product_title,
              latest.variant_title,
              '{}'::jsonb,
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.source_updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.shop_id = latest.shop_id
             AND bounds.variant_id = latest.variant_id
            ON CONFLICT (business_id, provider_account_id, shop_id, variant_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_variant_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_variant_dimensions.provider_account_ref_id),
              product_id = COALESCE(EXCLUDED.product_id, shopify_variant_dimensions.product_id),
              sku = COALESCE(EXCLUDED.sku, shopify_variant_dimensions.sku),
              product_title = COALESCE(EXCLUDED.product_title, shopify_variant_dimensions.product_title),
              variant_title = COALESCE(EXCLUDED.variant_title, shopify_variant_dimensions.variant_title),
              projection_json = CASE
                WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_variant_dimensions.projection_json
                ELSE EXCLUDED.projection_json
              END,
              first_seen_at = COALESCE(shopify_variant_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(shopify_variant_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(shopify_variant_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
      ]);

      await runMigrationBatchSequentially([
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                COALESCE(campaign_id, entity_key) AS campaign_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_campaign_daily
              WHERE COALESCE(campaign_id, entity_key) IS NOT NULL
              GROUP BY business_id, provider_account_id, COALESCE(campaign_id, entity_key)
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, COALESCE(campaign_id, entity_key))
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                COALESCE(campaign_id, entity_key) AS campaign_id,
                campaign_name,
                status,
                channel,
                payload_json,
                updated_at
              FROM google_ads_campaign_daily
              WHERE COALESCE(campaign_id, entity_key) IS NOT NULL
              ORDER BY business_id, provider_account_id, COALESCE(campaign_id, entity_key), date DESC, updated_at DESC
            )
            INSERT INTO google_ads_campaign_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              campaign_name,
              normalized_status,
              channel,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.campaign_name,
              latest.status,
              latest.channel,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.campaign_id = latest.campaign_id
            ON CONFLICT (business_id, provider_account_id, campaign_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_campaign_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_campaign_dimensions.provider_account_ref_id),
              campaign_name = EXCLUDED.campaign_name,
              normalized_status = EXCLUDED.normalized_status,
              channel = EXCLUDED.channel,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_campaign_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_campaign_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_campaign_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                COALESCE(ad_group_id, entity_key) AS ad_group_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_ad_group_daily
              WHERE COALESCE(ad_group_id, entity_key) IS NOT NULL
              GROUP BY business_id, provider_account_id, COALESCE(ad_group_id, entity_key)
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, COALESCE(ad_group_id, entity_key))
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                COALESCE(ad_group_id, entity_key) AS ad_group_id,
                ad_group_name,
                status,
                payload_json,
                updated_at
              FROM google_ads_ad_group_daily
              WHERE COALESCE(ad_group_id, entity_key) IS NOT NULL
              ORDER BY business_id, provider_account_id, COALESCE(ad_group_id, entity_key), date DESC, updated_at DESC
            )
            INSERT INTO google_ads_ad_group_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              ad_group_id,
              ad_group_name,
              normalized_status,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.ad_group_id,
              latest.ad_group_name,
              latest.status,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.ad_group_id = latest.ad_group_id
            ON CONFLICT (business_id, provider_account_id, ad_group_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_ad_group_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_ad_group_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              ad_group_name = EXCLUDED.ad_group_name,
              normalized_status = EXCLUDED.normalized_status,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_ad_group_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_ad_group_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_ad_group_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                entity_key AS ad_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_ad_daily
              WHERE entity_key IS NOT NULL
              GROUP BY business_id, provider_account_id, entity_key
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, entity_key)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                ad_group_id,
                entity_key AS ad_id,
                entity_label,
                status,
                payload_json,
                updated_at
              FROM google_ads_ad_daily
              WHERE entity_key IS NOT NULL
              ORDER BY business_id, provider_account_id, entity_key, date DESC, updated_at DESC
            )
            INSERT INTO google_ads_ad_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              ad_group_id,
              ad_id,
              ad_name,
              normalized_status,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.ad_group_id,
              latest.ad_id,
              COALESCE(NULLIF(latest.payload_json->>'name', ''), latest.entity_label),
              latest.status,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.ad_id = latest.ad_id
            ON CONFLICT (business_id, provider_account_id, ad_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_ad_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_ad_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              ad_group_id = EXCLUDED.ad_group_id,
              ad_name = EXCLUDED.ad_name,
              normalized_status = EXCLUDED.normalized_status,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_ad_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_ad_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_ad_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                entity_key AS keyword_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_keyword_daily
              WHERE entity_key IS NOT NULL
              GROUP BY business_id, provider_account_id, entity_key
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, entity_key)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                ad_group_id,
                entity_key AS keyword_id,
                entity_label,
                status,
                payload_json,
                updated_at
              FROM google_ads_keyword_daily
              WHERE entity_key IS NOT NULL
              ORDER BY business_id, provider_account_id, entity_key, date DESC, updated_at DESC
            )
            INSERT INTO google_ads_keyword_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              ad_group_id,
              keyword_id,
              keyword_text,
              normalized_status,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.ad_group_id,
              latest.keyword_id,
              COALESCE(
                NULLIF(latest.payload_json->>'keywordText', ''),
                NULLIF(latest.payload_json->>'keyword', ''),
                latest.entity_label
              ),
              latest.status,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.keyword_id = latest.keyword_id
            ON CONFLICT (business_id, provider_account_id, keyword_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_keyword_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_keyword_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              ad_group_id = EXCLUDED.ad_group_id,
              keyword_text = EXCLUDED.keyword_text,
              normalized_status = EXCLUDED.normalized_status,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_keyword_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_keyword_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_keyword_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                entity_key AS asset_group_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_asset_group_daily
              WHERE entity_key IS NOT NULL
              GROUP BY business_id, provider_account_id, entity_key
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, entity_key)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                entity_key AS asset_group_id,
                entity_label,
                status,
                payload_json,
                updated_at
              FROM google_ads_asset_group_daily
              WHERE entity_key IS NOT NULL
              ORDER BY business_id, provider_account_id, entity_key, date DESC, updated_at DESC
            )
            INSERT INTO google_ads_asset_group_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              asset_group_id,
              asset_group_name,
              normalized_status,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.asset_group_id,
              COALESCE(NULLIF(latest.payload_json->>'assetGroupName', ''), latest.entity_label),
              latest.status,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.asset_group_id = latest.asset_group_id
            ON CONFLICT (business_id, provider_account_id, asset_group_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_asset_group_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_asset_group_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              asset_group_name = EXCLUDED.asset_group_name,
              normalized_status = EXCLUDED.normalized_status,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_asset_group_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_asset_group_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_asset_group_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                entity_key AS product_key,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_product_daily
              WHERE entity_key IS NOT NULL
              GROUP BY business_id, provider_account_id, entity_key
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, entity_key)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                entity_key AS product_key,
                entity_label,
                status,
                payload_json,
                updated_at
              FROM google_ads_product_daily
              WHERE entity_key IS NOT NULL
              ORDER BY business_id, provider_account_id, entity_key, date DESC, updated_at DESC
            )
            INSERT INTO google_ads_product_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              product_key,
              product_title,
              normalized_status,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.product_key,
              COALESCE(
                NULLIF(latest.payload_json->>'productTitle', ''),
                NULLIF(latest.payload_json->>'title', ''),
                latest.entity_label
              ),
              latest.status,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.product_key = latest.product_key
            ON CONFLICT (business_id, provider_account_id, product_key) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_product_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_product_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              product_title = EXCLUDED.product_title,
              normalized_status = EXCLUDED.normalized_status,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_product_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_product_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_product_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            INSERT INTO google_ads_campaign_state_history (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              state_fingerprint,
              campaign_name,
              normalized_status,
              channel,
              projection_json,
              source_kind,
              source_snapshot_id,
              captured_at,
              effective_from,
              effective_to,
              created_at
            )
            SELECT
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              COALESCE(campaign_id, entity_key) AS campaign_id,
              md5(
                jsonb_build_object(
                  'campaign_name', campaign_name,
                  'normalized_status', status,
                  'channel', channel,
                  'projection_json', COALESCE(payload_json, '{}'::jsonb)
                )::text
              ) AS state_fingerprint,
              campaign_name,
              status,
              channel,
              COALESCE(payload_json, '{}'::jsonb),
              'warehouse_daily' AS source_kind,
              NULL::uuid AS source_snapshot_id,
              MAX(COALESCE(updated_at, date::timestamptz)) AS captured_at,
              MIN(date) AS effective_from,
              MAX(date) AS effective_to,
              now()
            FROM google_ads_campaign_daily
            WHERE COALESCE(campaign_id, entity_key) IS NOT NULL
            GROUP BY
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              COALESCE(campaign_id, entity_key),
              campaign_name,
              status,
              channel,
              COALESCE(payload_json, '{}'::jsonb)
            ON CONFLICT (business_id, provider_account_id, campaign_id, state_fingerprint, captured_at) DO NOTHING
          `,
        ).catch(() => {}),
        sql.query(
          `
            INSERT INTO google_ads_ad_group_state_history (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              ad_group_id,
              state_fingerprint,
              ad_group_name,
              normalized_status,
              projection_json,
              source_kind,
              source_snapshot_id,
              captured_at,
              effective_from,
              effective_to,
              created_at
            )
            SELECT
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              COALESCE(ad_group_id, entity_key) AS ad_group_id,
              md5(
                jsonb_build_object(
                  'ad_group_name', ad_group_name,
                  'normalized_status', status,
                  'projection_json', COALESCE(payload_json, '{}'::jsonb)
                )::text
              ) AS state_fingerprint,
              ad_group_name,
              status,
              COALESCE(payload_json, '{}'::jsonb),
              'warehouse_daily' AS source_kind,
              NULL::uuid AS source_snapshot_id,
              MAX(COALESCE(updated_at, date::timestamptz)) AS captured_at,
              MIN(date) AS effective_from,
              MAX(date) AS effective_to,
              now()
            FROM google_ads_ad_group_daily
            WHERE COALESCE(ad_group_id, entity_key) IS NOT NULL
            GROUP BY
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              COALESCE(ad_group_id, entity_key),
              ad_group_name,
              status,
              COALESCE(payload_json, '{}'::jsonb)
            ON CONFLICT (business_id, provider_account_id, ad_group_id, state_fingerprint, captured_at) DO NOTHING
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                campaign_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM meta_campaign_daily
              WHERE campaign_id IS NOT NULL
              GROUP BY business_id, provider_account_id, campaign_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, campaign_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                campaign_name_current,
                campaign_name_historical,
                campaign_status,
                buying_type,
                updated_at
              FROM meta_campaign_daily
              WHERE campaign_id IS NOT NULL
              ORDER BY business_id, provider_account_id, campaign_id, date DESC, updated_at DESC
            )
            INSERT INTO meta_campaign_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              campaign_name_current,
              campaign_name_historical,
              campaign_status,
              buying_type,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.campaign_name_current,
              latest.campaign_name_historical,
              latest.campaign_status,
              latest.buying_type,
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.campaign_id = latest.campaign_id
            ON CONFLICT (business_id, provider_account_id, campaign_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_campaign_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_campaign_dimensions.provider_account_ref_id),
              campaign_name_current = EXCLUDED.campaign_name_current,
              campaign_name_historical = EXCLUDED.campaign_name_historical,
              campaign_status = EXCLUDED.campaign_status,
              buying_type = EXCLUDED.buying_type,
              first_seen_at = COALESCE(meta_campaign_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(meta_campaign_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(meta_campaign_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                adset_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM meta_adset_daily
              WHERE adset_id IS NOT NULL
              GROUP BY business_id, provider_account_id, adset_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, adset_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                adset_id,
                adset_name_current,
                adset_name_historical,
                adset_status,
                updated_at
              FROM meta_adset_daily
              WHERE adset_id IS NOT NULL
              ORDER BY business_id, provider_account_id, adset_id, date DESC, updated_at DESC
            )
            INSERT INTO meta_adset_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              adset_id,
              adset_name_current,
              adset_name_historical,
              adset_status,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.adset_id,
              latest.adset_name_current,
              latest.adset_name_historical,
              latest.adset_status,
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.adset_id = latest.adset_id
            ON CONFLICT (business_id, provider_account_id, adset_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_adset_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_adset_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              adset_name_current = EXCLUDED.adset_name_current,
              adset_name_historical = EXCLUDED.adset_name_historical,
              adset_status = EXCLUDED.adset_status,
              first_seen_at = COALESCE(meta_adset_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(meta_adset_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(meta_adset_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                ad_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM meta_ad_daily
              WHERE ad_id IS NOT NULL
              GROUP BY business_id, provider_account_id, ad_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, ad_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                adset_id,
                ad_id,
                ad_name_current,
                ad_name_historical,
                ad_status,
                payload_json,
                updated_at
              FROM meta_ad_daily
              WHERE ad_id IS NOT NULL
              ORDER BY business_id, provider_account_id, ad_id, date DESC, updated_at DESC
            )
            INSERT INTO meta_ad_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              adset_id,
              ad_id,
              ad_name_current,
              ad_name_historical,
              ad_status,
              creative_id,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.adset_id,
              latest.ad_id,
              latest.ad_name_current,
              latest.ad_name_historical,
              latest.ad_status,
              NULLIF(latest.payload_json->>'creative_id', ''),
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.ad_id = latest.ad_id
            ON CONFLICT (business_id, provider_account_id, ad_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_ad_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_ad_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              adset_id = EXCLUDED.adset_id,
              ad_name_current = EXCLUDED.ad_name_current,
              ad_name_historical = EXCLUDED.ad_name_historical,
              ad_status = EXCLUDED.ad_status,
              creative_id = COALESCE(EXCLUDED.creative_id, meta_ad_dimensions.creative_id),
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(meta_ad_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(meta_ad_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(meta_ad_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                creative_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM meta_creative_daily
              WHERE creative_id IS NOT NULL
              GROUP BY business_id, provider_account_id, creative_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, creative_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                adset_id,
                ad_id,
                creative_id,
                creative_name,
                headline,
                primary_text,
                destination_url,
                thumbnail_url,
                asset_type,
                payload_json,
                updated_at
              FROM meta_creative_daily
              WHERE creative_id IS NOT NULL
              ORDER BY business_id, provider_account_id, creative_id, date DESC, updated_at DESC
            )
            INSERT INTO meta_creative_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              adset_id,
              ad_id,
              creative_id,
              creative_name,
              headline,
              primary_text,
              destination_url,
              thumbnail_url,
              asset_type,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.adset_id,
              latest.ad_id,
              latest.creative_id,
              latest.creative_name,
              latest.headline,
              latest.primary_text,
              latest.destination_url,
              latest.thumbnail_url,
              latest.asset_type,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.creative_id = latest.creative_id
            ON CONFLICT (business_id, provider_account_id, creative_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_creative_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_creative_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              adset_id = EXCLUDED.adset_id,
              ad_id = EXCLUDED.ad_id,
              creative_name = EXCLUDED.creative_name,
              headline = EXCLUDED.headline,
              primary_text = EXCLUDED.primary_text,
              destination_url = EXCLUDED.destination_url,
              thumbnail_url = EXCLUDED.thumbnail_url,
              asset_type = EXCLUDED.asset_type,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(meta_creative_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(meta_creative_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(meta_creative_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
        ).catch(() => {}),
        sql.query(
          `
            INSERT INTO meta_campaign_config_history (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              config_fingerprint,
              objective,
              optimization_goal,
              bid_strategy_type,
              bid_strategy_label,
              manual_bid_amount,
              bid_value,
              bid_value_format,
              daily_budget,
              lifetime_budget,
              is_budget_mixed,
              is_config_mixed,
              is_optimization_goal_mixed,
              is_bid_strategy_mixed,
              is_bid_value_mixed,
              source_kind,
              source_snapshot_id,
              captured_at,
              effective_from,
              effective_to,
              created_at
            )
            SELECT
              source.business_id,
              source.business_ref_id,
              source.provider_account_id,
              source.provider_account_ref_id,
              source.campaign_id,
              md5(
                jsonb_build_object(
                  'objective', source.objective,
                  'optimization_goal', source.optimization_goal,
                  'bid_strategy_type', source.bid_strategy_type,
                  'bid_strategy_label', source.bid_strategy_label,
                  'manual_bid_amount', source.manual_bid_amount,
                  'bid_value', source.bid_value,
                  'bid_value_format', source.bid_value_format,
                  'daily_budget', source.daily_budget,
                  'lifetime_budget', source.lifetime_budget,
                  'is_budget_mixed', source.is_budget_mixed,
                  'is_config_mixed', source.is_config_mixed,
                  'is_optimization_goal_mixed', source.is_optimization_goal_mixed,
                  'is_bid_strategy_mixed', source.is_bid_strategy_mixed,
                  'is_bid_value_mixed', source.is_bid_value_mixed
                )::text
              ) AS config_fingerprint,
              source.objective,
              source.optimization_goal,
              source.bid_strategy_type,
              source.bid_strategy_label,
              source.manual_bid_amount,
              source.bid_value,
              source.bid_value_format,
              source.daily_budget,
              source.lifetime_budget,
              source.is_budget_mixed,
              source.is_config_mixed,
              source.is_optimization_goal_mixed,
              source.is_bid_strategy_mixed,
              source.is_bid_value_mixed,
              source.source_kind,
              source.source_snapshot_id,
              source.captured_at,
              source.effective_from,
              source.effective_to,
              now()
            FROM (
              SELECT
                business_id,
                business_ref_id,
                account_id AS provider_account_id,
                provider_account_ref_id,
                entity_id AS campaign_id,
                NULLIF(payload->>'objective', '') AS objective,
                NULLIF(payload->>'optimizationGoal', '') AS optimization_goal,
                NULLIF(payload->>'bidStrategyType', '') AS bid_strategy_type,
                NULLIF(payload->>'bidStrategyLabel', '') AS bid_strategy_label,
                NULLIF(payload->>'manualBidAmount', '')::double precision AS manual_bid_amount,
                NULLIF(payload->>'bidValue', '')::double precision AS bid_value,
                NULLIF(payload->>'bidValueFormat', '') AS bid_value_format,
                NULLIF(payload->>'dailyBudget', '')::double precision AS daily_budget,
                NULLIF(payload->>'lifetimeBudget', '')::double precision AS lifetime_budget,
                COALESCE((payload->>'isBudgetMixed')::boolean, FALSE) AS is_budget_mixed,
                COALESCE((payload->>'isConfigMixed')::boolean, FALSE) AS is_config_mixed,
                COALESCE((payload->>'isOptimizationGoalMixed')::boolean, FALSE) AS is_optimization_goal_mixed,
                COALESCE((payload->>'isBidStrategyMixed')::boolean, FALSE) AS is_bid_strategy_mixed,
                COALESCE((payload->>'isBidValueMixed')::boolean, FALSE) AS is_bid_value_mixed,
                'config_snapshot'::text AS source_kind,
                NULL::uuid AS source_snapshot_id,
                captured_at,
                snapshot_date AS effective_from,
                snapshot_date AS effective_to
              FROM meta_config_snapshots
              WHERE entity_level = 'campaign'
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                objective,
                optimization_goal,
                bid_strategy_type,
                bid_strategy_label,
                manual_bid_amount,
                bid_value,
                bid_value_format,
                daily_budget,
                lifetime_budget,
                is_budget_mixed,
                is_config_mixed,
                is_optimization_goal_mixed,
                is_bid_strategy_mixed,
                is_bid_value_mixed,
                'warehouse_daily'::text AS source_kind,
                source_snapshot_id,
                COALESCE(finalized_at, (date::text || 'T00:00:00Z')::timestamptz) AS captured_at,
                date AS effective_from,
                date AS effective_to
              FROM meta_campaign_daily
              WHERE campaign_id IS NOT NULL
                AND (
                  objective IS NOT NULL
                  OR optimization_goal IS NOT NULL
                  OR bid_strategy_type IS NOT NULL
                  OR bid_strategy_label IS NOT NULL
                  OR manual_bid_amount IS NOT NULL
                  OR bid_value IS NOT NULL
                  OR daily_budget IS NOT NULL
                  OR lifetime_budget IS NOT NULL
                  OR is_budget_mixed = TRUE
                  OR is_config_mixed = TRUE
                  OR is_optimization_goal_mixed = TRUE
                  OR is_bid_strategy_mixed = TRUE
                  OR is_bid_value_mixed = TRUE
                )
            ) AS source
            WHERE source.campaign_id IS NOT NULL
            ON CONFLICT (business_id, provider_account_id, campaign_id, config_fingerprint, captured_at) DO NOTHING
          `,
        ).catch(() => {}),
        sql.query(
          `
            INSERT INTO meta_adset_config_history (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              adset_id,
              config_fingerprint,
              optimization_goal,
              bid_strategy_type,
              bid_strategy_label,
              manual_bid_amount,
              bid_value,
              bid_value_format,
              daily_budget,
              lifetime_budget,
              is_budget_mixed,
              is_config_mixed,
              is_optimization_goal_mixed,
              is_bid_strategy_mixed,
              is_bid_value_mixed,
              source_kind,
              source_snapshot_id,
              captured_at,
              effective_from,
              effective_to,
              created_at
            )
            SELECT
              source.business_id,
              source.business_ref_id,
              source.provider_account_id,
              source.provider_account_ref_id,
              source.campaign_id,
              source.adset_id,
              md5(
                jsonb_build_object(
                  'optimization_goal', source.optimization_goal,
                  'bid_strategy_type', source.bid_strategy_type,
                  'bid_strategy_label', source.bid_strategy_label,
                  'manual_bid_amount', source.manual_bid_amount,
                  'bid_value', source.bid_value,
                  'bid_value_format', source.bid_value_format,
                  'daily_budget', source.daily_budget,
                  'lifetime_budget', source.lifetime_budget,
                  'is_budget_mixed', source.is_budget_mixed,
                  'is_config_mixed', source.is_config_mixed,
                  'is_optimization_goal_mixed', source.is_optimization_goal_mixed,
                  'is_bid_strategy_mixed', source.is_bid_strategy_mixed,
                  'is_bid_value_mixed', source.is_bid_value_mixed
                )::text
              ) AS config_fingerprint,
              source.optimization_goal,
              source.bid_strategy_type,
              source.bid_strategy_label,
              source.manual_bid_amount,
              source.bid_value,
              source.bid_value_format,
              source.daily_budget,
              source.lifetime_budget,
              source.is_budget_mixed,
              source.is_config_mixed,
              source.is_optimization_goal_mixed,
              source.is_bid_strategy_mixed,
              source.is_bid_value_mixed,
              source.source_kind,
              source.source_snapshot_id,
              source.captured_at,
              source.effective_from,
              source.effective_to,
              now()
            FROM (
              SELECT
                business_id,
                business_ref_id,
                account_id AS provider_account_id,
                provider_account_ref_id,
                NULLIF(payload->>'campaignId', '') AS campaign_id,
                entity_id AS adset_id,
                NULLIF(payload->>'optimizationGoal', '') AS optimization_goal,
                NULLIF(payload->>'bidStrategyType', '') AS bid_strategy_type,
                NULLIF(payload->>'bidStrategyLabel', '') AS bid_strategy_label,
                NULLIF(payload->>'manualBidAmount', '')::double precision AS manual_bid_amount,
                NULLIF(payload->>'bidValue', '')::double precision AS bid_value,
                NULLIF(payload->>'bidValueFormat', '') AS bid_value_format,
                NULLIF(payload->>'dailyBudget', '')::double precision AS daily_budget,
                NULLIF(payload->>'lifetimeBudget', '')::double precision AS lifetime_budget,
                COALESCE((payload->>'isBudgetMixed')::boolean, FALSE) AS is_budget_mixed,
                COALESCE((payload->>'isConfigMixed')::boolean, FALSE) AS is_config_mixed,
                COALESCE((payload->>'isOptimizationGoalMixed')::boolean, FALSE) AS is_optimization_goal_mixed,
                COALESCE((payload->>'isBidStrategyMixed')::boolean, FALSE) AS is_bid_strategy_mixed,
                COALESCE((payload->>'isBidValueMixed')::boolean, FALSE) AS is_bid_value_mixed,
                'config_snapshot'::text AS source_kind,
                NULL::uuid AS source_snapshot_id,
                captured_at,
                snapshot_date AS effective_from,
                snapshot_date AS effective_to
              FROM meta_config_snapshots
              WHERE entity_level = 'adset'
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                adset_id,
                optimization_goal,
                bid_strategy_type,
                bid_strategy_label,
                manual_bid_amount,
                bid_value,
                bid_value_format,
                daily_budget,
                lifetime_budget,
                is_budget_mixed,
                is_config_mixed,
                is_optimization_goal_mixed,
                is_bid_strategy_mixed,
                is_bid_value_mixed,
                'warehouse_daily'::text AS source_kind,
                source_snapshot_id,
                COALESCE(finalized_at, (date::text || 'T00:00:00Z')::timestamptz) AS captured_at,
                date AS effective_from,
                date AS effective_to
              FROM meta_adset_daily
              WHERE adset_id IS NOT NULL
                AND (
                  optimization_goal IS NOT NULL
                  OR bid_strategy_type IS NOT NULL
                  OR bid_strategy_label IS NOT NULL
                  OR manual_bid_amount IS NOT NULL
                  OR bid_value IS NOT NULL
                  OR daily_budget IS NOT NULL
                  OR lifetime_budget IS NOT NULL
                  OR is_budget_mixed = TRUE
                  OR is_config_mixed = TRUE
                  OR is_optimization_goal_mixed = TRUE
                  OR is_bid_strategy_mixed = TRUE
                  OR is_bid_value_mixed = TRUE
                )
            ) AS source
            WHERE source.adset_id IS NOT NULL
            ON CONFLICT (business_id, provider_account_id, adset_id, config_fingerprint, captured_at) DO NOTHING
          `,
        ).catch(() => {}),
      ]);

      await runMigrationBatchSequentially([
        ...CANONICAL_BUSINESS_REF_TABLES.map((tableName) =>
          sql.query(
            `CREATE INDEX IF NOT EXISTS idx_${tableName}_business_ref ON ${tableName} (business_ref_id)`,
          ).catch(() => {}),
        ),
        ...CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql.query(
            `CREATE INDEX IF NOT EXISTS idx_${tableName}_provider_account_ref ON ${tableName} (provider_account_ref_id)`,
          ).catch(() => {}),
        ),
      ]);

      if (legacyCoreDropEnabled) {
        await runMigrationBatchSequentially([
          sql`DROP TABLE IF EXISTS provider_account_snapshots`.catch(() => {}),
          sql`DROP TABLE IF EXISTS provider_account_assignments`.catch(() => {}),
          sql`DROP TABLE IF EXISTS integrations`.catch(() => {}),
        ]);
      }

      // ── Seed superadmin ───────────────────────────────────────────────────
      await sql`UPDATE users SET is_superadmin = true WHERE lower(email) = 'emrahbilaloglu@gmail.com'`;

      migrationsCompleted = true;
      logStartupEvent("migrations_completed", { reason });
    })(),
    timeoutMs,
  );

  try {
    await migrationsPromise;
  } catch (error) {
    migrationsPromise = null;

    const isSystemCatalogRace =
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505" &&
      "table" in error &&
      typeof (error as { table: string }).table === "string" &&
      ["pg_type", "pg_class"].includes((error as { table: string }).table);

    if (isSystemCatalogRace) {
      migrationsCompleted = true;
      logStartupEvent("migrations_completed_after_race", { reason });
      return;
    }

    logStartupError("migrations_failed", error, { reason, force });
    throw error;
  }
}
