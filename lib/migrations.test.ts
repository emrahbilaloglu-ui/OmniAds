import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/startup-diagnostics", () => ({
  logStartupError: vi.fn(),
  logStartupEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  getDbWithTimeout: vi.fn(),
}));

const db = await import("@/lib/db");
const startupDiagnostics = await import("@/lib/startup-diagnostics");

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
    expect(queries.join("\n")).toContain("idx_meta_creative_daily_business_account_date_creative");
    expect(queries.join("\n")).toContain("CREATE TABLE IF NOT EXISTS meta_creative_media");
    expect(queries.join("\n")).toContain(
      "DROP CONSTRAINT IF EXISTS meta_creative_media_business_id_provider_account_id_date_creative_id_key",
    );
    expect(queries.join("\n")).toContain("old_constraint_name");
    expect(queries.join("\n")).toContain("idx_meta_creative_media_ad_grain");
    expect(queries.join("\n")).toContain("idx_meta_creative_media_business_date");
    expect(queries.join("\n")).toContain("idx_google_ads_account_daily_business_account_date");
    expect(queries.join("\n")).toContain("idx_shopify_orders_business_account_created_local");
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
    });

    const joinedQueries = queries.join("\n");
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
    });

    const joinedQueries = queries.join("\n");
    expect(joinedQueries).toContain("ALTER TABLE shopify_orders\n          DROP COLUMN IF EXISTS payload_json");
    expect(joinedQueries).toContain("ALTER TABLE shopify_order_lines\n          DROP COLUMN IF EXISTS payload_json");
    expect(joinedQueries).toContain("ALTER TABLE shopify_refunds\n          DROP COLUMN IF EXISTS payload_json");
    expect(joinedQueries).toContain("ALTER TABLE shopify_order_transactions\n          DROP COLUMN IF EXISTS payload_json");
    expect(joinedQueries).toContain("ALTER TABLE shopify_returns\n          DROP COLUMN IF EXISTS payload_json");
    expect(joinedQueries).toContain("ALTER TABLE shopify_sales_events\n          DROP COLUMN IF EXISTS payload_json");
    expect(joinedQueries).toContain("ALTER TABLE shopify_customer_events\n          DROP COLUMN IF EXISTS payload_json");
    expect(joinedQueries).toContain("ALTER TABLE shopify_webhook_deliveries\n          DROP COLUMN IF EXISTS payload_json");
    expect(joinedQueries).toContain("ALTER TABLE shopify_webhook_deliveries\n          DROP COLUMN IF EXISTS result_summary");
    expect(joinedQueries).toContain("ALTER TABLE shopify_repair_intents\n          DROP COLUMN IF EXISTS last_sync_result");
    expect(joinedQueries).toContain("ALTER TABLE shopify_sync_state\n          DROP COLUMN IF EXISTS last_result_summary");
    expect(joinedQueries).not.toContain("CREATE TABLE IF NOT EXISTS shopify_repair_intents (\n          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n          business_id TEXT NOT NULL,\n          provider_account_id TEXT NOT NULL,\n          entity_type TEXT NOT NULL,\n          entity_id TEXT NOT NULL,\n          topic TEXT NOT NULL,\n          payload_hash TEXT NOT NULL,\n          event_timestamp TIMESTAMPTZ,\n          event_age_days INTEGER,\n          escalation_level INTEGER NOT NULL DEFAULT 0,\n          status TEXT NOT NULL DEFAULT 'pending',\n          attempt_count INTEGER NOT NULL DEFAULT 0,\n          last_error TEXT,\n          last_sync_result JSONB,");
    expect(joinedQueries).not.toContain("CREATE TABLE IF NOT EXISTS shopify_sync_state (\n          business_id              TEXT NOT NULL,\n          provider_account_id      TEXT NOT NULL,\n          sync_target              TEXT NOT NULL,\n          historical_target_start  DATE,\n          historical_target_end    DATE,\n          ready_through_date       DATE,\n          cursor_timestamp         TIMESTAMPTZ,\n          cursor_value             TEXT,\n          latest_sync_started_at   TIMESTAMPTZ,\n          latest_successful_sync_at TIMESTAMPTZ,\n          latest_sync_status       TEXT,\n          latest_sync_window_start DATE,\n          latest_sync_window_end   DATE,\n          last_error               TEXT,\n          last_result_summary      JSONB,");
  });
});
