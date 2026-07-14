import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/startup-diagnostics", () => ({
  logStartupError: vi.fn(),
  logStartupEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  getDbWithTimeout: vi.fn(),
  runDbTransaction: vi.fn(async (operation: () => Promise<unknown>) =>
    operation(),
  ),
}));

const db = await import("@/lib/db");
const startupDiagnostics = await import("@/lib/startup-diagnostics");

function expectDropColumnQuery(queries: string, tableName: string, columnName: string) {
  expect(queries).toMatch(
    new RegExp(`ALTER TABLE ${tableName}\\s+DROP COLUMN IF EXISTS ${columnName}`),
  );
}

describe("runMigrations", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.ENABLE_RUNTIME_MIGRATIONS = "true";
    delete process.env.DB_DROP_LEGACY_CORE_TABLES;
    delete process.env.DB_ENABLE_LEGACY_CORE_COMPAT_TABLES;
  });

  it("uses the explicit timeout override DB client when provided", async () => {
    const queries: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join(" "));
        return [];
      }),
      {
        query: vi.fn(async (query: string) => {
          queries.push(query);
          return [];
        }),
      }
    );
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(db.getDbWithTimeout).mockReturnValue(sql as never);

    const migrations = await import("@/lib/migrations");
    await migrations.runMigrations({
      force: true,
      reason: "test",
      timeoutMs: 120_000,
      verifyNativeSchemaCapabilities: false,
    });

    expect(db.getDbWithTimeout).toHaveBeenCalledWith(120_000);
    expect(db.getDb).not.toHaveBeenCalled();
    expect(startupDiagnostics.logStartupEvent).toHaveBeenCalledWith(
      "migrations_started",
      expect.objectContaining({
        reason: "test",
        force: true,
        timeoutMs: 120_000,
      }),
    );
    expect(queries.join("\n")).toContain("provider_connections");
    expect(queries.join("\n")).toContain("integration_credentials");
    expect(queries.join("\n")).toContain("provider_accounts");
    expect(queries.join("\n")).toContain("business_provider_accounts");
    expect(queries.join("\n")).toContain("provider_account_snapshot_runs");
    expect(queries.join("\n")).toContain("provider_account_snapshot_items");
    expect(queries.join("\n")).toContain("platform_overview_summary_range_accounts");
    expect(queries.join("\n")).toContain("meta_campaign_dimensions");
    expect(queries.join("\n")).toContain("meta_campaign_config_history");
    expect(queries.join("\n")).toContain("meta_adset_dimensions");
    expect(queries.join("\n")).toContain("meta_adset_config_history");
    expect(queries.join("\n")).toContain("meta_ad_dimensions");
    expect(queries.join("\n")).toContain("meta_creative_dimensions");
    expect(queries.join("\n")).toContain("google_ads_campaign_dimensions");
    expect(queries.join("\n")).toContain("google_ads_campaign_state_history");
    expect(queries.join("\n")).toContain("google_ads_ad_group_dimensions");
    expect(queries.join("\n")).toContain("google_ads_ad_group_state_history");
    expect(queries.join("\n")).toContain("google_ads_ad_dimensions");
    expect(queries.join("\n")).toContain("google_ads_keyword_dimensions");
    expect(queries.join("\n")).toContain("google_ads_asset_group_dimensions");
    expect(queries.join("\n")).toContain("google_ads_product_dimensions");
    expect(queries.join("\n")).toContain("CREATE TABLE IF NOT EXISTS sync_incidents");
    expect(queries.join("\n")).toContain("business_ref_id");
    expect(queries.join("\n")).toContain("provider_account_ref_id");
    expect(queries.join("\n")).toContain("cost_cogs_percent");
    expect(queries.join("\n")).toContain("cost_shipping_percent");
    expect(queries.join("\n")).toContain("cost_fulfillment_percent");
    expect(queries.join("\n")).toContain("cost_payment_processing_percent");
    expect(queries.join("\n")).toContain("idx_meta_account_daily_business_account_date");
    expect(queries.join("\n")).toContain("pg_get_constraintdef(oid) NOT ILIKE '%superseded%'");
    expect(queries.join("\n")).toContain("DROP CONSTRAINT meta_raw_snapshots_status_check");
    expect(queries.join("\n")).toContain(
      "CHECK (status IN ('fetched', 'partial', 'failed', 'superseded'))",
    );
    expect(queries.join("\n")).toContain("idx_meta_creative_daily_business_account_date_creative");
    expect(queries.join("\n")).toContain("CREATE TABLE IF NOT EXISTS meta_creative_media");
    expect(queries.join("\n")).toContain("preset_override TEXT NULL");
    expect(queries.join("\n")).toContain(
      "preset_override IN ('aggressive', 'balanced', 'conservative')",
    );
    expect(queries.join("\n")).toContain(
      "DROP CONSTRAINT IF EXISTS meta_creative_media_business_id_provider_account_id_date_creative_id_key",
    );
    expect(queries.join("\n")).toContain("old_constraint_name");
    expect(queries.join("\n")).toContain("idx_meta_creative_media_ad_grain");
    expect(queries.join("\n")).toContain("idx_meta_creative_media_business_date");
    expect(queries.join("\n")).toContain("CREATE TABLE IF NOT EXISTS meta_campaign_labels");
    expect(queries.join("\n")).toContain("campaign_kind IN ('main', 'test', 'mixed')");
    expect(queries.join("\n")).toContain("campaign_kind IN ('all', 'main', 'test', 'mixed')");
    expect(queries.join("\n")).toContain(
      "ADD COLUMN IF NOT EXISTS campaign_kind TEXT NOT NULL DEFAULT 'all'",
    );
    expect(queries.join("\n")).toContain(
      "ADD PRIMARY KEY (business_id, scope_type, scope_id, snapshot_date, metric_name, cohort, campaign_kind)",
    );
    expect(queries.join("\n")).toContain("idx_meta_campaign_labels_business_kind");
    expect(queries.join("\n")).toContain("idx_google_ads_account_daily_business_account_date");
    expect(queries.join("\n")).toContain("idx_shopify_orders_business_account_created_local");
    expect(queries.join("\n")).toContain("SET lock_timeout = '2000ms'");
    expectDropColumnQuery(queries.join("\n"), "meta_campaign_daily", "bid_strategy_label");
    expectDropColumnQuery(queries.join("\n"), "meta_campaign_daily", "manual_bid_amount");
    expectDropColumnQuery(queries.join("\n"), "meta_adset_daily", "bid_strategy_label");
    expectDropColumnQuery(queries.join("\n"), "meta_adset_daily", "manual_bid_amount");
  });

  it("drops only retired legacy core tables when the cleanup switch is enabled", async () => {
    const queries: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join(" "));
        return [];
      }),
      {
        query: vi.fn(async (query: string) => {
          queries.push(query);
          if (query.includes("SELECT to_regclass")) {
            return [{ exists: true }];
          }
          return [];
        }),
      }
    );
    process.env.DB_DROP_LEGACY_CORE_TABLES = "1";
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(db.getDbWithTimeout).mockReturnValue(sql as never);

    const migrations = await import("@/lib/migrations");
    await migrations.runMigrations({
      force: true,
      reason: "legacy-cleanup-test",
      verifyNativeSchemaCapabilities: false,
    });

    const joinedQueries = queries.join("\n");
    expect(joinedQueries).toContain(
      "INSERT INTO business_target_pack_history",
    );
    expect(joinedQueries).toContain(
      "WHERE history.business_id = target.business_id",
    );
    expect(joinedQueries).toContain("DROP TABLE IF EXISTS provider_account_snapshots");
    expect(joinedQueries).toContain("DROP TABLE IF EXISTS provider_account_assignments");
    expect(joinedQueries).toContain("DROP TABLE IF EXISTS integrations");
    expect(joinedQueries).not.toContain("DROP TABLE IF EXISTS provider_connections");
    expect(joinedQueries).not.toContain("DROP TABLE IF EXISTS integration_credentials");
    expect(joinedQueries).not.toContain("DROP TABLE IF EXISTS provider_account_snapshot_runs");
    expect(joinedQueries).not.toContain("CREATE TABLE IF NOT EXISTS integrations");
    expect(joinedQueries).not.toContain("CREATE TABLE IF NOT EXISTS provider_account_assignments");
    expect(joinedQueries).not.toContain("CREATE TABLE IF NOT EXISTS provider_account_snapshots");
  });

  it("drops retired Shopify inline payload and detail columns during cleanup cutover", async () => {
    const queries: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join(" "));
        return [];
      }),
      {
        query: vi.fn(async (query: string) => {
          queries.push(query);
          return [];
        }),
      }
    );
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(db.getDbWithTimeout).mockReturnValue(sql as never);

    const migrations = await import("@/lib/migrations");
    await migrations.runMigrations({
      force: true,
      reason: "shopify-cutover-test",
      verifyNativeSchemaCapabilities: false,
    });

    const joinedQueries = queries.join("\n");
    expect(joinedQueries).toContain("SET lock_timeout = '2000ms'");
    expectDropColumnQuery(joinedQueries, "shopify_orders", "payload_json");
    expectDropColumnQuery(joinedQueries, "shopify_order_lines", "payload_json");
    expectDropColumnQuery(joinedQueries, "shopify_refunds", "payload_json");
    expectDropColumnQuery(joinedQueries, "shopify_order_transactions", "payload_json");
    expectDropColumnQuery(joinedQueries, "shopify_returns", "payload_json");
    expectDropColumnQuery(joinedQueries, "shopify_sales_events", "payload_json");
    expectDropColumnQuery(joinedQueries, "shopify_customer_events", "payload_json");
    expectDropColumnQuery(joinedQueries, "shopify_webhook_deliveries", "payload_json");
    expectDropColumnQuery(joinedQueries, "shopify_webhook_deliveries", "result_summary");
    expectDropColumnQuery(joinedQueries, "shopify_repair_intents", "last_sync_result");
    expectDropColumnQuery(joinedQueries, "shopify_sync_state", "last_result_summary");
    expect(joinedQueries).not.toContain("CREATE TABLE IF NOT EXISTS shopify_repair_intents (\n          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n          business_id TEXT NOT NULL,\n          provider_account_id TEXT NOT NULL,\n          entity_type TEXT NOT NULL,\n          entity_id TEXT NOT NULL,\n          topic TEXT NOT NULL,\n          payload_hash TEXT NOT NULL,\n          event_timestamp TIMESTAMPTZ,\n          event_age_days INTEGER,\n          escalation_level INTEGER NOT NULL DEFAULT 0,\n          status TEXT NOT NULL DEFAULT 'pending',\n          attempt_count INTEGER NOT NULL DEFAULT 0,\n          last_error TEXT,\n          last_sync_result JSONB,");
    expect(joinedQueries).not.toContain("CREATE TABLE IF NOT EXISTS shopify_sync_state (\n          business_id              TEXT NOT NULL,\n          provider_account_id      TEXT NOT NULL,\n          sync_target              TEXT NOT NULL,\n          historical_target_start  DATE,\n          historical_target_end    DATE,\n          ready_through_date       DATE,\n          cursor_timestamp         TIMESTAMPTZ,\n          cursor_value             TEXT,\n          latest_sync_started_at   TIMESTAMPTZ,\n          latest_successful_sync_at TIMESTAMPTZ,\n          latest_sync_status       TEXT,\n          latest_sync_window_start DATE,\n          latest_sync_window_end   DATE,\n          last_error               TEXT,\n          last_result_summary      JSONB,");
  });

  it("skips expensive Meta config history backfills when history tables already have rows", async () => {
    const queries: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join(" "));
        return [];
      }),
      {
        query: vi.fn(async (query: string) => {
          queries.push(query);
          if (
            query.includes("SELECT EXISTS (SELECT 1 FROM meta_campaign_config_history") ||
            query.includes("SELECT EXISTS (SELECT 1 FROM meta_adset_config_history")
          ) {
            return [{ exists: true }];
          }
          return [];
        }),
      }
    );
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(db.getDbWithTimeout).mockReturnValue(sql as never);

    const migrations = await import("@/lib/migrations");
    await migrations.runMigrations({
      force: true,
      reason: "config-history-guard-test",
      verifyNativeSchemaCapabilities: false,
    });

    const joinedQueries = queries.join("\n");
    expect(joinedQueries).not.toContain("INSERT INTO meta_campaign_config_history");
    expect(joinedQueries).not.toContain("INSERT INTO meta_adset_config_history");
    expect(startupDiagnostics.logStartupEvent).toHaveBeenCalledWith(
      "migration_config_history_backfill_skipped_existing_rows",
      { tableName: "meta_campaign_config_history" },
    );
    expect(startupDiagnostics.logStartupEvent).toHaveBeenCalledWith(
      "migration_config_history_backfill_skipped_existing_rows",
      { tableName: "meta_adset_config_history" },
    );
  });

  it("skips provider account seed scans when provider accounts already exist", async () => {
    const queries: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join(" "));
        return [];
      }),
      {
        query: vi.fn(async (query: string) => {
          queries.push(query);
          if (
            query.includes(
              "SELECT EXISTS (SELECT 1 FROM provider_accounts WHERE provider = $1 LIMIT 1)",
            )
          ) {
            return [{ exists: true }];
          }
          return [];
        }),
      },
    );
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(db.getDbWithTimeout).mockReturnValue(sql as never);

    const migrations = await import("@/lib/migrations");
    await migrations.runMigrations({
      force: true,
      reason: "provider-seed-guard-test",
      verifyNativeSchemaCapabilities: false,
    });

    const providerSeedQueries = queries.filter(
      (query) =>
        query.includes("INSERT INTO provider_accounts") &&
        query.includes("seed.external_account_id"),
    );
    expect(providerSeedQueries).toHaveLength(0);
    expect(startupDiagnostics.logStartupEvent).toHaveBeenCalledWith(
      "migration_provider_account_seed_skipped_existing_rows",
      { provider: "meta" },
    );
    expect(startupDiagnostics.logStartupEvent).toHaveBeenCalledWith(
      "migration_provider_account_seed_skipped_existing_rows",
      { provider: "google" },
    );
    expect(startupDiagnostics.logStartupEvent).toHaveBeenCalledWith(
      "migration_provider_account_seed_skipped_existing_rows",
      { provider: "shopify" },
    );
  });

  it("skips Google Ads product dimension backfill when product dimensions already exist", async () => {
    const queries: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join(" "));
        return [];
      }),
      {
        query: vi.fn(async (query: string) => {
          queries.push(query);
          if (
            query.includes(
              "SELECT EXISTS (SELECT 1 FROM google_ads_product_dimensions LIMIT 1)",
            )
          ) {
            return [{ exists: true }];
          }
          return [];
        }),
      },
    );
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(db.getDbWithTimeout).mockReturnValue(sql as never);

    const migrations = await import("@/lib/migrations");
    await migrations.runMigrations({
      force: true,
      reason: "google-product-dimension-guard-test",
      verifyNativeSchemaCapabilities: false,
    });

    const productBackfillQueries = queries.filter(
      (query) =>
        query.includes("INSERT INTO google_ads_product_dimensions") &&
        query.includes("FROM google_ads_product_daily"),
    );
    expect(productBackfillQueries).toHaveLength(0);
    expect(startupDiagnostics.logStartupEvent).toHaveBeenCalledWith(
      "migration_dimension_backfill_skipped_existing_rows",
      { tableName: "google_ads_product_dimensions" },
    );
  });

  it("guards Meta dimension backfills behind destination-table emptiness checks", async () => {
    const queries: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join(" "));
        return [];
      }),
      {
        query: vi.fn(async (query: string) => {
          queries.push(query);
          if (
            query.includes("SELECT EXISTS (SELECT 1 FROM meta_campaign_dimensions LIMIT 1)") ||
            query.includes("SELECT EXISTS (SELECT 1 FROM meta_adset_dimensions LIMIT 1)") ||
            query.includes("SELECT EXISTS (SELECT 1 FROM meta_ad_dimensions LIMIT 1)") ||
            query.includes("SELECT EXISTS (SELECT 1 FROM meta_creative_dimensions LIMIT 1)")
          ) {
            return [{ exists: true }];
          }
          return [];
        }),
      },
    );
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(db.getDbWithTimeout).mockReturnValue(sql as never);

    const migrations = await import("@/lib/migrations");
    await migrations.runMigrations({
      force: true,
      reason: "meta-dimension-guard-test",
      verifyNativeSchemaCapabilities: false,
    });

    const joinedQueries = queries.join("\n");
    for (const tableName of [
      "meta_campaign_dimensions",
      "meta_adset_dimensions",
      "meta_ad_dimensions",
      "meta_creative_dimensions",
    ]) {
      expect(joinedQueries).toContain(
        `SELECT NOT EXISTS (SELECT 1 FROM ${tableName} LIMIT 1) AS enabled`,
      );
      expect(startupDiagnostics.logStartupEvent).toHaveBeenCalledWith(
        "migration_dimension_backfill_skipped_existing_rows",
        { tableName },
      );
    }
  });

  it("adds cohort-scoped Meta calibration migrations idempotently", async () => {
    const queries: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join(" "));
        return [];
      }),
      {
        query: vi.fn(async (query: string) => {
          queries.push(query);
          return [];
        }),
      },
    );
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(db.getDbWithTimeout).mockReturnValue(sql as never);

    const migrations = await import("@/lib/migrations");
    await migrations.runMigrations({
      force: true,
      reason: "meta-calibration-cohort-test",
      verifyNativeSchemaCapabilities: false,
    });
    await migrations.runMigrations({
      force: true,
      reason: "meta-calibration-cohort-test-rerun",
      verifyNativeSchemaCapabilities: false,
    });

    const joinedQueries = queries.join("\n");
    expect(joinedQueries).toContain("cohort        TEXT NOT NULL DEFAULT 'purchase'");
    expect(joinedQueries).toContain("campaign_kind TEXT NOT NULL DEFAULT 'all'");
    expect(joinedQueries).toContain(
      "ADD COLUMN IF NOT EXISTS cohort TEXT NOT NULL DEFAULT 'purchase'",
    );
    expect(joinedQueries).toContain(
      "ADD COLUMN IF NOT EXISTS campaign_kind TEXT NOT NULL DEFAULT 'all'",
    );
    expect(joinedQueries).toContain("SET cohort = 'purchase'");
    expect(joinedQueries).toContain("SET campaign_kind = 'all'");
    expect(joinedQueries).toContain("WHERE cohort IS NULL");
    expect(joinedQueries).toContain("WHERE campaign_kind IS NULL");
    expect(joinedQueries).toContain("set_config('lock_timeout', '2000ms', true)");
    expect(joinedQueries).toContain("current_pk_columns IS DISTINCT FROM desired_pk_columns");
    expect(joinedQueries).toContain(
      "ALTER TABLE meta_decision_calibration_daily DROP CONSTRAINT %I",
    );
    expect(joinedQueries).toContain(
      "ADD PRIMARY KEY (business_id, scope_type, scope_id, snapshot_date, metric_name, cohort, campaign_kind)",
    );
    expect(joinedQueries).toContain("idx_meta_calibration_cohort_scope");
  });
});
