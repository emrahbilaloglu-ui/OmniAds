import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/startup-diagnostics", () => ({
  logStartupError: vi.fn(),
  logStartupEvent: vi.fn(),
}));

vi.mock("@/lib/migration-verification", () => ({
  // These suites drive the migration statements against a fake SQL client, so
  // there is no catalog for the post-migration verifier to read. Its own
  // behaviour — including every negative case — is covered in
  // lib/migration-verification.test.ts and proven end to end by the real-PG
  // seams; mocking it here keeps this suite about the statements it emits.
  verifyMigrationSchemaContract: vi.fn(async () => ({ verified: 0 })),
}));

vi.mock("@/lib/meta/automation-claim-schema-verification", () => ({
  // The Automation claim schema's own post-migration gate, neutralized for the
  // same reason and on the same terms as the verifier above: this suite drives
  // the migration statements against a fake SQL client, so there is no catalog
  // to read. It is NOT weakened by being mocked here — it is proven end to end
  // by scripts/ephemeral-postgres-automation-claim-race-seam.ts, which migrates
  // a real PostgreSQL from zero, upgrades a real pre-claim schema, and then
  // reproduces an unrepairable schema state and requires the migration to exit
  // NON-ZERO over it.
  assertMetaAutomationClaimSchema: vi.fn(async () => []),
}));

vi.mock("@/lib/meta/budget-schema-verification", () => ({
  /*
    PRE-DEPLOY AUDIT — the D088 budget schema postcondition, neutralized here
    on exactly the terms of the two gates above: this suite drives the
    migration statements against a fake SQL client, so `information_schema`
    and `pg_constraint` answer nothing and the assertion could only ever
    report the fake catalog's emptiness.

    It is NOT weakened by being mocked here. It is proven end to end against a
    real PostgreSQL by scripts/d088-budget-proposal-migration-seam.ts, which
    migrates from zero, asserts all nine objects by name and definition, and
    then executes both the previous image's three-column upsert and the
    current one to prove the migration stayed survivable by a rollback.
  */
  assertD088BudgetSchema: vi.fn(async () => ({
    contract: "meta.d088-budget-schema-verification.v1",
    verified: [],
  })),
  D088BudgetSchemaError: class extends Error {},
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  getDbWithTimeout: vi.fn(),
  runDbTransaction: vi.fn(async (operation: () => Promise<unknown>) =>
    operation(),
  ),
  /*
    ── ROUND 20, ITEM 3 ──────────────────────────────────────────────────────
    Round 18 moved the whole run onto a PINNED lease and Round 20 moved the
    native-ad DDL group onto that same lease. Neither export existed in this
    mock, so every test in this file threw
    `withPinnedDbClient is not a function` before reaching its assertion. They
    are wired per test by `wirePinnedDb` below.
  */
  withPinnedDbClient: vi.fn(),
  runPinnedDbTransaction: vi.fn(),
}));

const db = await import("@/lib/db");
const startupDiagnostics = await import("@/lib/startup-diagnostics");
const { migrationDbMockModule } = await import(
  "@/lib/__tests__/pinned-migration-client-mock"
);

/**
 * Point every `@/lib/db` seam the migration runner uses at one capturing mock:
 * the pooled readers, the pinned lease, and the transaction the native-ad group
 * opens ON that lease.
 */
function wirePinnedDb(sql: unknown) {
  const module = migrationDbMockModule(sql as never);
  vi.mocked(db.getDb).mockReturnValue(sql as never);
  vi.mocked(db.getDbWithTimeout).mockReturnValue(sql as never);
  vi.mocked(db.withPinnedDbClient).mockImplementation(
    module.withPinnedDbClient as never,
  );
  vi.mocked(db.runPinnedDbTransaction).mockImplementation(
    module.runPinnedDbTransaction as never,
  );
}

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
    wirePinnedDb(sql);

    const migrations = await import("@/lib/migrations");
    await migrations.runMigrations({
      force: true,
      reason: "test",
      timeoutMs: 120_000,
      verifyNativeSchemaCapabilities: false,
    });

    /*
      ── ROUND 20, ITEM 3 ────────────────────────────────────────────────────
      The override used to be observed through `getDbWithTimeout`, which only
      the native-ad group called -- and that group has stopped calling it,
      because it now runs on the lease the rest of the migration already holds.
      The override is observed where it is now actually honoured: the bounded
      DDL transaction opened on that pinned lease, which receives BOTH the
      statement timeout and the proven lock bound.
    */
    expect(db.runPinnedDbTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: expect.any(Number),
        deadlineAtMs: expect.any(Number),
        lockTimeoutMs: 15_000,
      }),
    );
    expect(
      vi.mocked(db.runPinnedDbTransaction).mock.calls[0]?.[0].timeoutMs,
    ).toBeLessThanOrEqual(120_000);
    expect(db.withPinnedDbClient).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
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
    expect(queries.join("\n")).toContain("INSERT INTO memberships");
    expect(queries.join("\n")).toContain("business.owner_id");
    expect(queries.join("\n")).toContain(
      "ON CONFLICT (user_id, business_id) DO NOTHING",
    );
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
    // Merchant Center item state: additive, idempotent, and keyed on the item
    // rather than on a date, because an approval has no yesterday.
    expect(queries.join("\n")).toContain(
      "CREATE TABLE IF NOT EXISTS google_merchant_center_item_state",
    );
    expect(queries.join("\n")).toContain(
      "UNIQUE (business_id, provider_account_id, item_id)",
    );
    expect(queries.join("\n")).toContain(
      "idx_google_merchant_center_item_state_business_account",
    );
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

  it("settles at one absolute deadline and does not overlap a delayed prior run", async () => {
    const sql = Object.assign(
      vi.fn(async () => []),
      { query: vi.fn(async () => []) },
    );
    const module = migrationDbMockModule(sql as never);
    let releaseStart!: () => void;
    const delayedStart = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let leaseStarts = 0;
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(db.getDbWithTimeout).mockReturnValue(sql as never);
    vi.mocked(db.withPinnedDbClient).mockImplementation(async (fn, options) => {
      leaseStarts += 1;
      await delayedStart;
      return module.withPinnedDbClient(fn as never, options as never);
    });
    vi.mocked(db.runPinnedDbTransaction).mockImplementation(
      module.runPinnedDbTransaction as never,
    );

    const migrations = await import("@/lib/migrations");
    const startedAt = Date.now();
    const first = migrations.runMigrations({
      force: true,
      reason: "absolute-deadline-delayed-start",
      timeoutMs: 40,
      verifyNativeSchemaCapabilities: false,
    });

    await expect(first).rejects.toThrow("timed out after 40ms");
    expect(Date.now() - startedAt).toBeLessThan(300);

    const retryStartedAt = Date.now();
    await expect(migrations.runMigrations({
      force: true,
      reason: "must-not-overlap",
      timeoutMs: 40,
      verifyNativeSchemaCapabilities: false,
    })).rejects.toThrow("timed out after 40ms");
    expect(Date.now() - retryStartedAt).toBeLessThan(100);
    expect(leaseStarts).toBe(1);

    releaseStart();
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    wirePinnedDb(sql);

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
    wirePinnedDb(sql);

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
    wirePinnedDb(sql);

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
    wirePinnedDb(sql);

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
    wirePinnedDb(sql);

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
    wirePinnedDb(sql);

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
    wirePinnedDb(sql);

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
