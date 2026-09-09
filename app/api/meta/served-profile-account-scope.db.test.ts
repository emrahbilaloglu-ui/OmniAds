// @vitest-environment node
//
// THE SERVED ACCOUNT DECISION PROFILE IS ONE PHYSICAL ACCOUNT'S, AND IT AGREES
// WITH THAT ACCOUNT'S OWN RETAINED VERDICT.
//
// WHAT WAS WRONG. `app/api/meta/decisions-workspace/route.ts` resolved the
// commercial-anchor profile against a plain `WarehouseDataSource`. Only the
// store's observed AOV was account-scoped; every measured read
// `resolveAccountDecisionProfile` performs — the account calibration, its
// kind-segmented variants, the funnel pack and the live Meta-attributed AOV it
// falls back to — defaults to the business's whole Meta footprint. On a
// business holding two ad accounts the panel therefore served a verdict
// computed from both. Driven at the route, before the fix, with account A
// carrying 6 mature creatives and account B carrying 32:
//
//   served   system.commercialAnchor.actions.scale
//              = {eligible: true, blockerCode: null}
//            lineage.metaAttributedAovPurchaseCount90d = 38
//            lineage.accountCpaSampleCount             = 38
//   retained engine_v3_account_profile_output for A, same day
//              = scale eligible=false blocker=scale_calibration_below_floor
//
// One response, two contradictory commercial verdicts about the same account —
// and the operator-facing half authorised a budget increase that the budget
// path, reading A's own retained row, refuses. The 38 is the tell: it is A's
// six converters plus B's thirty-two, and the pooled calibration behind it
// clears the 30-creative automation-quality floor that A's own six cannot.
//
// WHAT THIS FILE PROVES, through the REAL exported route handler under a REAL
// session cookie, against a REAL migrated ephemeral database:
//
//   1. A's served anchor and served budget lineage equal A's OWN retained
//      `engine_v3_account_profile_output` rows — eligibility, blocker code and
//      spend unit — and carry A's own measured lineage, not the pooled one.
//   2. Moving B's facts materially and re-running the shipped calibration job,
//      the retention producer and the route leaves A's served answer
//      byte-identical, while B's own retained verdict visibly moves.
//   3. With no Shopify store, an account with no purchases of its own no longer
//      inherits a sibling's Meta-attributed AOV: it holds with the resolver's
//      own `commercial_anchor_missing`, and the sibling keeps its own anchor.
//   4. Two accounts in different currencies do not contaminate each other: the
//      USD account answers from its own Meta-attributed AOV and the JPY one,
//      having none, holds instead of inheriting it.
//   5. An account the calibration pass has not covered is served the RETENTION
//      PATH'S OWN NAMED HOLD — `account_calibration_scope_not_materialised` —
//      rather than a pooled borrow or an unexplained absence, and the producer
//      refuses the same account under the same name.
//   6. An account whose OWN Meta purchase sample is ready still resolves and
//      still agrees with its own retained rows, so nothing below is a
//      one-directional relaxation into a permanent hold.
//
// THE COMMERCIAL BASIS, RE-PINNED. Several cases here used to assert
// `observed_shopify_aov` — the store's 58.00 over the 2.20 target ROAS, 26.36.
// That rung has been removed from `resolveSpendUnit`: for a META decision the
// hard-decision spend unit is META's own attributed purchase AOV for THIS
// account divided by the target ROAS, and the merchant's settled Shopify orders
// are a different book. Every re-pin below is therefore stricter, not looser —
// account A now holds on its own six-purchase sample, and account C, which has
// measured nothing at all, no longer becomes anchored on a business-level store
// number the moment calibration covers it.
//
// NOTHING IS MOCKED except the process-level absence of the network: no Meta
// connection is seeded, so `resolveMetaCredentials` answers null from the
// database and the provider inventory degrades honestly. `globalThis.fetch` is
// replaced by a recorder that throws, and the test asserts it was never called.
// Every calibration row, every retained verdict and every served payload is
// produced by shipped code — `runCalibrationJob`,
// `produceRetainedAccountProfileOutputs` and the route's own `GET`.
//
// THE CLUSTER. A throwaway PostgreSQL cluster on a random free port that is
// never 5432 (this machine's local volume) and never 15432 (an SSH tunnel to
// production), migrated by the repo's own `scripts/run-migrations.ts` in a
// child process whose `DATABASE_URL` is pre-set so `@next/env` cannot
// substitute `.env.local`. It is stopped and deleted afterwards. When no
// PostgreSQL binaries are present the whole file skips rather than passing
// vacuously.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedCanonicalMetaAdDailyFacts } from "@/lib/creative-decision-engine/meta-aov-calculator.test-helpers";
import { seedHealthyDbHostCapacitySnapshot } from "@/lib/sync/db-growth-fence.test-helpers";

/** Never the local volume, never the production tunnel. */
const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB_NAME = "adsecute_served_profile_scope";
const DB_USER = "postgres";

function postgresBinDir(): string | null {
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR ?? "",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    "/usr/local/opt/postgresql@16/bin",
    "/usr/bin",
  ].filter(Boolean);
  return (
    candidates.find((dir) =>
      ["initdb", "pg_ctl", "createdb"].every((bin) =>
        fs.existsSync(path.join(dir, bin)),
      ),
    ) ?? null
  );
}

const PG_BIN = postgresBinDir();
const RUNNABLE = PG_BIN !== null;

// PostgreSQL refuses to start with "postmaster became multithreaded during
// startup" unless LC_ALL names a valid locale, and the ambient environment is
// enough to fail on macOS.
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function migrate(databaseUrl: string) {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join("scripts", "run-migrations.ts")],
      {
        cwd: process.cwd(),
        stdio: "ignore",
        env: {
          ...process.env,
          LC_ALL: "C",
          // Pre-set so `scripts/run-migrations.ts`'s own `loadEnvConfig`
          // cannot substitute `.env.local` — which in this repository points
          // at PRODUCTION through an SSH tunnel.
          DATABASE_URL: databaseUrl,
          DATABASE_URL_UNPOOLED: databaseUrl,
          DB_SSL_MODE: "disable",
        },
      },
    );
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) throw new Error(`run-migrations exited ${code}`);
}

const OWNER = "d0000000-0000-4000-8000-0000000009ff";

/** Two accounts, one store, one business: the case the defect lived in. */
const SCOPE_BUSINESS = "d0000000-0000-4000-8000-000000000901";
const SCOPE_A = "act_9000000000011";
const SCOPE_B = "act_9000000000012";
/** Assigned only AFTER the calibration pass, which is an ordinary state. */
const SCOPE_C = "act_9000000000013";
const SCOPE_SHOP = "served-profile-scope.myshopify.test";

/** No store at all, so the Meta-attributed rung is the only one left. */
const NOSTORE_BUSINESS = "d0000000-0000-4000-8000-000000000902";
const NOSTORE_P = "act_9000000000021";
const NOSTORE_Q = "act_9000000000022";

/** One USD store, one USD account and one JPY account. */
const FX_BUSINESS = "d0000000-0000-4000-8000-000000000903";
const FX_USD = "act_9000000000031";
const FX_JPY = "act_9000000000032";
const FX_SHOP = "served-profile-fx.myshopify.test";

/**
 * A store and an account denominated in a currency the ISO minor-unit registry
 * does not carry. `lib/currency/iso-4217-minor-units.ts` deliberately covers
 * fewer codes than ISO publishes, and KES is one it does not carry.
 */
const NOEXP_BUSINESS = "d0000000-0000-4000-8000-000000000904";
const NOEXP_ACCOUNT = "act_9000000000041";
const NOEXP_SHOP = "served-profile-noexp.myshopify.test";

function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** The last completed UTC day, which is the day every fixture speaks for. */
const AS_OF = addDays(new Date().toISOString().slice(0, 10), -1);

function metricRow(input: {
  spend: number;
  revenue: number;
  conversions: number;
  impressions: number;
  clicks: number;
  reach: number;
}) {
  return {
    spend: input.spend,
    revenue: input.revenue,
    conversions: input.conversions,
    impressions: input.impressions,
    clicks: input.clicks,
    reach: input.reach,
    frequency: input.reach > 0 ? input.impressions / input.reach : null,
    roas: input.spend > 0 ? input.revenue / input.spend : 0,
    cpa: input.conversions > 0 ? input.spend / input.conversions : null,
    ctr: input.impressions > 0 ? (input.clicks / input.impressions) * 100 : null,
    cpc: input.clicks > 0 ? input.spend / input.clicks : null,
  };
}

type AnchorAction = {
  action: string;
  eligible: boolean;
  blockerCode: string | null;
  operatorCopy: string | null;
};

type ServedWorkspace = {
  anchor: {
    status: string;
    unavailableReason: string | null;
    explanation: {
      status: string;
      spendUnit: number | null;
      spendUnitSource: string;
      thresholdEligible: boolean;
      missingInputs: string[];
      lineage: Record<string, unknown>;
      actions: Record<string, AnchorAction>;
    } | null;
    actions: AnchorAction[];
  };
  lineage: Record<"increase" | "decrease", Record<string, unknown>>;
};

type RetainedVerdict = {
  action: string;
  eligible: boolean;
  blocker_code: string | null;
  spend_unit: string | null;
};

let dataDir = "";
let started = false;
let pgCtl = "";
const fetchCalls: string[] = [];

describe.skipIf(!RUNNABLE)(
  "the served account decision profile is one physical account's",
  () => {
    let db: typeof import("@/lib/db");
    let sessionCookie = "";
    let route: typeof import("@/app/api/meta/decisions-workspace/route");
    let produceRetained: typeof import("@/lib/meta/account-profile-output-producer").produceRetainedAccountProfileOutputs;
    let calibrate: (businessId: string) => Promise<void>;
    let seedMetaAccount: (input: {
      businessId: string;
      account: string;
      currency: string;
    }) => Promise<void>;
    let seedCreatives: (input: {
      businessId: string;
      account: string;
      count: number;
      offset: number;
      spend: number;
      revenue: number;
      /**
       * The account's own currency. `upsertMetaCreativeDailyRows` writes it
       * back onto `provider_accounts`, so a fixture that hardcodes USD here
       * silently re-denominates the account it is seeding.
       */
      currency: string;
    }) => Promise<void>;

    /** The served workspace for one account, through the real GET handler. */
    const serve = async (
      businessId: string,
      account: string,
    ): Promise<ServedWorkspace> => {
      const response = await route.GET(
        new NextRequest(
          `http://localhost/api/meta/decisions-workspace?businessId=${businessId}&providerAccountId=${account}&window=28d`,
          { headers: { cookie: sessionCookie } },
        ),
      );
      const payload = (await response.json()) as Record<string, any>;
      if (response.status !== 200) {
        throw new Error(
          `route ${response.status} for ${account}: ${JSON.stringify(payload).slice(0, 500)}`,
        );
      }
      return {
        anchor: payload.system.commercialAnchor,
        lineage: {
          increase: payload.system.budgetEvidence.increase.commercialLineage,
          decrease: payload.system.budgetEvidence.decrease.commercialLineage,
        },
      };
    };

    /** One account's retained verdicts, read straight back out of the table. */
    const retained = async (
      businessId: string,
      account: string,
    ): Promise<RetainedVerdict[]> =>
      (await db.getDb().query(
        `SELECT action, eligible, blocker_code, spend_unit::text AS spend_unit
           FROM engine_v3_account_profile_output
          WHERE business_id = $1 AND provider_account_id = $2 AND as_of_date = $3::date
          ORDER BY action`,
        [businessId, account, AS_OF],
      )) as RetainedVerdict[];

    beforeAll(async () => {
      const port = await freePort();
      if (FORBIDDEN_PORTS.has(port)) {
        throw new Error(`Refusing forbidden PostgreSQL port ${port}.`);
      }
      const bin = PG_BIN!;
      pgCtl = path.join(bin, "pg_ctl");
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-sps-"));
      dataDir = path.join(tempDir, "data");
      // A SHORT socket directory: the data directory sits under the OS temp
      // path, and PostgreSQL's socket path limit is shorter than that.
      const socketDir = fs.mkdtempSync(path.join("/tmp", "sps-"));
      run(path.join(bin, "initdb"), [
        "-D",
        dataDir,
        "-U",
        DB_USER,
        "-A",
        "trust",
        "--no-locale",
        "--encoding=UTF8",
      ]);
      run(pgCtl, [
        "-D",
        dataDir,
        "-l",
        path.join(tempDir, "postgres.log"),
        "-o",
        `-F -h 127.0.0.1 -p ${port} -k ${socketDir}`,
        "-w",
        "start",
      ]);
      started = true;
      run(path.join(bin, "createdb"), [
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        DB_USER,
        DB_NAME,
      ]);
      const databaseUrl = `postgresql://${DB_USER}@127.0.0.1:${port}/${DB_NAME}`;
      await migrate(databaseUrl);
      // Set before anything imports `@/lib/db`, which reads the URL when the
      // pool is first created.
      process.env.DATABASE_URL = databaseUrl;
      process.env.DATABASE_URL_UNPOOLED = databaseUrl;
      process.env.DB_SSL_MODE = "disable";
      // The route's own shipped override. Its default under VITEST is HTTP so
      // that suites can mock `fetch`; this file wants the two upstreams
      // executed for real, in process, against this database.
      process.env.META_DECISIONS_UPSTREAM_TRANSPORT = "in_process";

      db = await import("@/lib/db");
      const sql = db.getDb();
      await seedHealthyDbHostCapacitySnapshot(sql, "served-profile-test-host");
      const { upsertMetaAdDailyRows, upsertMetaCreativeDailyRows } = await import(
        "@/lib/meta/warehouse"
      );
      const { runCalibrationJob } = await import(
        "@/lib/creative-decision-engine/jobs/calibration-job"
      );
      ({ produceRetainedAccountProfileOutputs: produceRetained } = await import(
        "@/lib/meta/account-profile-output-producer"
      ));

      calibrate = async (businessId: string) => {
        const job = await runCalibrationJob({ businessId, asOf: AS_OF });
        if (job.status !== "success") {
          throw new Error(
            `calibration job ${job.status} for ${businessId}: ${job.errorMessage ?? ""}`,
          );
        }
      };

      seedMetaAccount = async (input) => {
        const rows = (await sql.query(
          `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone)
           VALUES ('meta', $1, $1, $2, 'UTC')
           ON CONFLICT (provider, external_account_id) DO UPDATE SET currency = EXCLUDED.currency
           RETURNING id::text AS id`,
          [input.account, input.currency],
        )) as Array<{ id: string }>;
        await sql.query(
          `INSERT INTO business_provider_accounts
             (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
           VALUES ($1, 'meta', $2::uuid, $3, 0, TRUE)
           ON CONFLICT (business_id, provider, provider_account_ref_id)
           DO UPDATE SET is_selected = TRUE`,
          [input.businessId, rows[0]!.id, input.account],
        );
      };

      seedCreatives = async (input) => {
        const digits = input.account.replace(/\D/g, "");
        const rows = [];
        for (let index = 0; index < input.count; index += 1) {
          const ordinal = input.offset + index;
          rows.push({
            businessId: input.businessId,
            providerAccountId: input.account,
            accountTimezone: "UTC",
            accountCurrency: input.currency,
            sourceSnapshotId: null,
            date: AS_OF,
            campaignId: `${digits}01`,
            adsetId: `${digits}02`,
            adId: `${digits}3${String(ordinal).padStart(3, "0")}`,
            creativeId: `${digits}4${String(ordinal).padStart(3, "0")}`,
            creativeName: `Converter ${ordinal}`,
            headline: null,
            primaryText: null,
            destinationUrl: null,
            thumbnailUrl: null,
            assetType: "image",
            objective: "OUTCOME_SALES",
            optimizationGoal: "OFFSITE_CONVERSIONS",
            effectiveStatus: "ACTIVE",
            ...metricRow({
              spend: input.spend,
              revenue: input.revenue,
              conversions: 1,
              impressions: 400,
              clicks: 8,
              reach: 300,
            }),
          });
        }
        await upsertMetaCreativeDailyRows(rows);
        await seedCanonicalMetaAdDailyFacts({
          sql,
          rows,
          write: upsertMetaAdDailyRows,
        });
      };

      const seedBusiness = async (businessId: string, name: string) => {
        await sql.query(
          `INSERT INTO businesses (id, name, owner_id, timezone, currency, is_demo_business)
           VALUES ($1::uuid, $2, $3::uuid, 'UTC', 'USD', FALSE) ON CONFLICT (id) DO NOTHING`,
          [businessId, name, OWNER],
        );
        await sql.query(
          `INSERT INTO memberships (user_id, business_id, role, status)
           VALUES ($1::uuid, $2::uuid, 'admin', 'active') ON CONFLICT DO NOTHING`,
          [OWNER, businessId],
        );
        /*
          ROAS ONLY. Target CPA and the operator AOV assumption are both NULL on
          purpose: this product requires a ROAS target and nothing else, and
          their absence must never be a blocker. It also makes the store's own
          average order value the only source of a money-per-purchase unit,
          which is what makes the account scope of the Meta-attributed rung
          observable at all.
        */
        await sql.query(
          `INSERT INTO business_target_pack_history
             (business_id, target_roas, break_even_roas, target_cpa, break_even_cpa,
              aov_assumption, default_risk_posture, operation, effective_at, recorded_at)
           VALUES ($1::uuid, 2.20, 1.80, NULL, NULL, NULL, 'balanced', 'upsert',
                   $2::timestamptz, $2::timestamptz)`,
          [businessId, `${AS_OF}T00:00:00.000Z`],
        );
      };

      const seedShopifyStore = async (input: {
        businessId: string;
        shop: string;
        currency: string;
        price: number;
      }) => {
        const conn = (await sql.query(
          `INSERT INTO provider_connections
             (business_id, provider, status, provider_account_id, provider_account_name, connected_at)
           VALUES ($1, 'shopify', 'connected', $2, 'Served profile store', now())
           RETURNING id::text AS id`,
          [input.businessId, input.shop],
        )) as Array<{ id: string }>;
        // A plaintext token is correct: `decryptIntegrationSecret` passes
        // through anything not prefixed `enc:v1:`. The zone is what makes a
        // store DAY definable at all.
        await sql.query(
          `INSERT INTO integration_credentials (provider_connection_id, access_token, metadata)
           VALUES ($1::uuid, 'served-profile-token', $2::jsonb)`,
          [conn[0]!.id, JSON.stringify({ iana_timezone: "UTC" })],
        );
        // The SUCCESS window pair is the one `proveShopifyOrderWindowCovered`
        // reads; the attempt pair alone proves nothing.
        await sql.query(
          `INSERT INTO shopify_sync_state
             (business_id, provider_account_id, sync_target, latest_successful_sync_at,
              latest_sync_window_start, latest_sync_window_end,
              latest_successful_sync_window_start, latest_successful_sync_window_end,
              ready_through_date, latest_sync_status)
           VALUES ($1, $2, 'commerce_orders_recent', now(), $3::date, $4::date,
                   $3::date, $4::date, $4::date, 'succeeded')
           ON CONFLICT (business_id, provider_account_id, sync_target)
           DO UPDATE SET latest_successful_sync_at = EXCLUDED.latest_successful_sync_at`,
          [input.businessId, input.shop, addDays(AS_OF, -60), AS_OF],
        );
        // Thirty orders inside the closed window, which is the observed order
        // floor exactly.
        for (let index = 0; index < 30; index += 1) {
          const day = addDays(AS_OF, -(1 + (index % 27)));
          await sql.query(
            `INSERT INTO shopify_orders
               (business_id, provider_account_id, shop_id, order_id, currency_code,
                shop_currency_code, order_created_at, order_created_date_local,
                total_price, current_total_price, original_total_price)
             VALUES ($1, $2, $2, $3, $6, $6, $4::timestamptz, $5::date, $7, $7, $7)
             ON CONFLICT DO NOTHING`,
            [
              input.businessId,
              input.shop,
              `order-${index}`,
              `${day}T12:00:00.000Z`,
              day,
              input.currency,
              input.price,
            ],
          );
          await sql.query(
            `INSERT INTO shopify_sales_events
               (business_id, provider_account_id, shop_id, event_id, source_kind,
                source_id, order_id, occurred_at, occurred_date_local,
                gross_sales, net_revenue, currency_code)
             VALUES ($1, $2, $2, $3, 'order', $4, $4, $5::timestamptz, $6::date, $7, $7, $8)
             ON CONFLICT DO NOTHING`,
            [
              input.businessId,
              input.shop,
              `event-${index}`,
              `order-${index}`,
              `${day}T12:00:00.000Z`,
              day,
              input.price,
              input.currency,
            ],
          );
        }
      };

      await sql.query(
        `INSERT INTO users (id, email, name, password_hash)
         VALUES ($1::uuid, 'served-profile-seam@example.test', 'Served profile seam', 'x')
         ON CONFLICT (id) DO NOTHING`,
        [OWNER],
      );

      // --- the two-account business the defect lived in -------------------
      await seedBusiness(SCOPE_BUSINESS, "Served profile scope");
      await seedMetaAccount({
        businessId: SCOPE_BUSINESS,
        account: SCOPE_A,
        currency: "USD",
      });
      await seedMetaAccount({
        businessId: SCOPE_BUSINESS,
        account: SCOPE_B,
        currency: "USD",
      });
      /*
        Six mature converters for A against thirty-two for B, and materially
        different revenue per conversion, so A's own reading, B's own reading
        and the pooled reading are three different numbers. The scale
        calibration floor is thirty, so A alone cannot be scale-eligible and A
        pooled with B can.
      */
      await seedCreatives({
        businessId: SCOPE_BUSINESS,
        account: SCOPE_A,
        count: 6,
        offset: 0,
        spend: 10,
        revenue: 36,
        currency: "USD",
      });
      await seedCreatives({
        businessId: SCOPE_BUSINESS,
        account: SCOPE_B,
        count: 32,
        offset: 0,
        spend: 10,
        revenue: 12,
        currency: "USD",
      });
      await seedShopifyStore({
        businessId: SCOPE_BUSINESS,
        shop: SCOPE_SHOP,
        currency: "USD",
        price: 58.0,
      });

      // --- no store: the Meta-attributed rung is the only one left --------
      await seedBusiness(NOSTORE_BUSINESS, "Served profile no store");
      await seedMetaAccount({
        businessId: NOSTORE_BUSINESS,
        account: NOSTORE_P,
        currency: "USD",
      });
      await seedMetaAccount({
        businessId: NOSTORE_BUSINESS,
        account: NOSTORE_Q,
        currency: "USD",
      });
      await seedCreatives({
        businessId: NOSTORE_BUSINESS,
        account: NOSTORE_P,
        count: 32,
        offset: 0,
        spend: 10,
        revenue: 44,
        currency: "USD",
      });
      // Q gets nothing at all: no ads, no purchases, no evidence.

      // --- two currencies, one USD store ----------------------------------
      await seedBusiness(FX_BUSINESS, "Served profile FX");
      await seedMetaAccount({
        businessId: FX_BUSINESS,
        account: FX_USD,
        currency: "USD",
      });
      await seedMetaAccount({
        businessId: FX_BUSINESS,
        account: FX_JPY,
        currency: "JPY",
      });
      await seedCreatives({
        businessId: FX_BUSINESS,
        account: FX_USD,
        count: 32,
        offset: 0,
        spend: 10,
        revenue: 36,
        currency: "USD",
      });
      await seedShopifyStore({
        businessId: FX_BUSINESS,
        shop: FX_SHOP,
        currency: "USD",
        price: 58.0,
      });

      // --- a currency the minor-unit registry does not carry --------------
      await seedBusiness(NOEXP_BUSINESS, "Served profile unknown exponent");
      await seedMetaAccount({
        businessId: NOEXP_BUSINESS,
        account: NOEXP_ACCOUNT,
        currency: "KES",
      });
      await seedCreatives({
        businessId: NOEXP_BUSINESS,
        account: NOEXP_ACCOUNT,
        count: 32,
        offset: 0,
        spend: 10,
        revenue: 36,
        currency: "KES",
      });
      await seedShopifyStore({
        businessId: NOEXP_BUSINESS,
        shop: NOEXP_SHOP,
        currency: "KES",
        price: 58.0,
      });

      for (const businessId of [
        SCOPE_BUSINESS,
        NOSTORE_BUSINESS,
        FX_BUSINESS,
        NOEXP_BUSINESS,
      ]) {
        await calibrate(businessId);
      }
      for (const [businessId, account] of [
        [SCOPE_BUSINESS, SCOPE_A],
        [SCOPE_BUSINESS, SCOPE_B],
        [NOSTORE_BUSINESS, NOSTORE_P],
        [NOSTORE_BUSINESS, NOSTORE_Q],
        [FX_BUSINESS, FX_USD],
        [FX_BUSINESS, FX_JPY],
        [NOEXP_BUSINESS, NOEXP_ACCOUNT],
      ] as const) {
        await produceRetained({
          businessId,
          providerAccountId: account,
          asOfDate: AS_OF,
        });
      }

      // REAL request auth: a fresh in-memory token for the seeded user; only
      // its sha256 is written, into the throwaway cluster.
      const token = randomBytes(32).toString("hex");
      await sql.query(
        `INSERT INTO sessions (user_id, token_hash, active_business_id, expires_at)
         VALUES ($1::uuid, $2, $3::uuid, now() + interval '1 hour')`,
        [
          OWNER,
          createHash("sha256").update(token).digest("hex"),
          SCOPE_BUSINESS,
        ],
      );
      sessionCookie = `omniads_session=${token}`;

      // No network, and the test proves nothing reached for it.
      (globalThis as unknown as { fetch: unknown }).fetch = (
        ...args: unknown[]
      ) => {
        fetchCalls.push(String(args[0]).slice(0, 200));
        throw new Error("network access is forbidden in this seam");
      };

      route = await import("@/app/api/meta/decisions-workspace/route");
    }, 300_000);

    afterAll(async () => {
      try {
        db?.resetDbClientCache?.();
        await new Promise((resolve) => setTimeout(resolve, 250));
      } catch {
        /* the cluster is going away regardless */
      }
      if (started && pgCtl && dataDir) {
        spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "stop"], {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C" },
        });
        fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
      }
    }, 60_000);

    it("serves account A the verdict A's own retained rows carry", async () => {
      const served = await serve(SCOPE_BUSINESS, SCOPE_A);
      const rows = await retained(SCOPE_BUSINESS, SCOPE_A);

      // The producer retained a verdict for A, so there is something to agree
      // with. Its absence would make every comparison below vacuous.
      expect(rows.map((row) => row.action)).toEqual([
        "cut",
        "refresh",
        "scale",
      ]);

      /*
        THE COMMERCIAL ANCHOR IS A'S OWN META-ATTRIBUTED AOV, and it is the
        reason A holds.

        RE-PINNED. This used to assert `eligible_observed_shopify_aov` /
        `observed_shopify_aov` — the store's 58.00 over the 2.20 target ROAS,
        26.36 — because the store rung sat in `resolveSpendUnit` at HIGH
        confidence. It has been removed: for a Meta decision the unit is META's
        own attributed purchase AOV, and the store's settled orders are a
        different book. A's own attributed sample is six purchases, below the
        `ready` bar of twenty, so the ladder holds and the panel says so by
        name rather than sizing from Shopify.

        ROUND 6: the hold is now TOTAL. A thin sample under a Target ROAS
        builds no unit at all — it used to produce `meta_derived_aov` at 36.00
        / 2.20 with `hardEligibleByDefault: false`, which closed the action gate
        while leaving that number to size the maturity floor, the thresholds and
        the canonical hash. The STATUS is unchanged and is the point of this
        case: the panel still names A's own sample as the reason, and still
        does not reach for the store's 58.00.
      */
      expect(served.anchor.status).toBe("resolved");
      expect(served.anchor.explanation?.status).toBe(
        "blocked_meta_aov_sample_insufficient",
      );
      expect(served.anchor.explanation?.spendUnitSource).toBe("insufficient");
      expect(served.anchor.explanation?.spendUnit).toBeNull();
      // And specifically not the store's 58.00 / 2.20 = 26.36, nor A's own
      // 36.00 / 2.20 = 16.36 that the thin sample cannot authorize.
      expect(served.anchor.explanation?.spendUnit).not.toBeCloseTo(58 / 2.2, 9);

      // A'S OWN MEASUREMENT, NOT THE POOLED ONE. A has six mature creatives and
      // B has thirty-two; before the fix both of these numbers were 38.
      expect(
        served.anchor.explanation?.lineage.metaAttributedAovPurchaseCount90d,
      ).toBe(6);
      expect(served.anchor.explanation?.lineage.accountCpaSampleCount).toBe(6);

      // Eligibility, blocker code and spend unit, against A's OWN retained row.
      const retainedByAction = new Map(rows.map((row) => [row.action, row]));
      for (const action of ["scale", "cut", "refresh"] as const) {
        const row = retainedByAction.get(action)!;
        const servedAction = served.anchor.actions.find(
          (entry) => entry.action === action,
        )!;
        expect({
          action,
          eligible: servedAction.eligible,
          blockerCode: servedAction.blockerCode,
        }).toEqual({
          action,
          eligible: row.eligible,
          blockerCode: row.blocker_code,
        });
        expect(row.spend_unit).toBeNull();
        expect(served.anchor.explanation!.spendUnit).toBeNull();
      }

      /*
        And the retained truth is what makes this bite. A used to be
        commercially anchored on the store (cut and refresh eligible) and
        blocked only on Scale by its own calibration floor. Now the commercial
        threshold itself is unmet — A's six attributed purchases are below the
        `ready` bar — so the anchor blocker outranks the calibration one and
        every action is withheld under it. A's calibration is still below the
        floor; it is simply no longer the FIRST reason.
      */
      expect(retainedByAction.get("scale")!.eligible).toBe(false);
      for (const action of ["scale", "cut", "refresh"] as const) {
        expect(retainedByAction.get(action)!.eligible).toBe(false);
        expect(retainedByAction.get(action)!.blocker_code).toBe(
          "commercial_anchor_sample_insufficient",
        );
      }

      // budgetGateFacts carries the same per-action truth: an increase is a
      // scale decision and a decrease is a cut decision.
      expect(served.lineage.increase).toMatchObject({
        selectedAction: "scale",
        eligible: false,
        code: "commercial_anchor_sample_insufficient",
        availability: { status: "resolved" },
      });
      expect(served.lineage.decrease).toMatchObject({
        selectedAction: "cut",
        eligible: false,
        code: "commercial_anchor_sample_insufficient",
        availability: { status: "resolved" },
      });
    });

    it("does not move A when only B moves", async () => {
      const before = await serve(SCOPE_BUSINESS, SCOPE_A);
      const bBefore = await retained(SCOPE_BUSINESS, SCOPE_B);

      // Forty more converters for B at a materially different revenue. The
      // pooled reading cannot survive this; A's own reading is untouched.
      await seedCreatives({
        businessId: SCOPE_BUSINESS,
        account: SCOPE_B,
        count: 40,
        offset: 100,
        spend: 10,
        revenue: 200,
        currency: "USD",
      });
      await calibrate(SCOPE_BUSINESS);
      await produceRetained({
        businessId: SCOPE_BUSINESS,
        providerAccountId: SCOPE_B,
        asOfDate: AS_OF,
      });

      const after = await serve(SCOPE_BUSINESS, SCOPE_A);
      const bAfter = await retained(SCOPE_BUSINESS, SCOPE_B);

      // B really did move — otherwise "A is unchanged" proves nothing.
      expect(bBefore.length).toBeGreaterThan(0);
      expect(JSON.stringify(bAfter)).not.toBe(JSON.stringify(bBefore));

      // A did not, byte for byte, in both the anchor and the budget lineage.
      expect(JSON.stringify(after.anchor)).toBe(JSON.stringify(before.anchor));
      expect(JSON.stringify(after.lineage)).toBe(
        JSON.stringify(before.lineage),
      );

      // The values themselves, so a reader sees WHAT was preserved rather than
      // only that something was.
      expect(
        after.anchor.explanation?.lineage.metaAttributedAovPurchaseCount90d,
      ).toBe(6);
      /*
        ROUND 6: A's six-purchase sample builds no unit, so what is preserved
        byte for byte is the HOLD — including the lineage numbers that say
        whose sample it was. The claim this case makes is unchanged: B moving
        does not move A.
      */
      expect(after.anchor.explanation?.spendUnit).toBeNull();
      expect(after.anchor.explanation?.lineage.metaAttributedAovMean90d).toBe(36);
      expect(
        after.anchor.actions.find((entry) => entry.action === "scale"),
      ).toMatchObject({
        eligible: false,
        blockerCode: "commercial_anchor_sample_insufficient",
      });

      // And A's served answer still equals A's OWN retained rows, which the
      // re-run left alone.
      const aRows = await retained(SCOPE_BUSINESS, SCOPE_A);
      expect(
        aRows.map((row) => `${row.action}:${row.eligible}:${row.blocker_code}`),
      ).toEqual([
        "cut:false:commercial_anchor_sample_insufficient",
        "refresh:false:commercial_anchor_sample_insufficient",
        "scale:false:commercial_anchor_sample_insufficient",
      ]);
    });

    it("refuses to lend a sibling's Meta AOV when there is no store", async () => {
      const withPurchases = await serve(NOSTORE_BUSINESS, NOSTORE_P);
      const without = await serve(NOSTORE_BUSINESS, NOSTORE_Q);

      // P's anchor is P's own Meta-attributed average order value.
      expect(withPurchases.anchor.explanation?.spendUnitSource).toBe(
        "meta_derived_aov",
      );
      expect(
        withPurchases.anchor.explanation?.lineage.metaAttributedAovMean90d,
      ).toBe(44);

      // Q has no purchases of its own, and is now told so instead of being
      // handed P's. The code is the resolver's, not this test's.
      expect(
        without.anchor.explanation?.lineage.metaAttributedAovMean90d ?? null,
      ).toBeNull();
      expect(without.anchor.explanation?.spendUnitSource).toBe("insufficient");
      for (const action of without.anchor.actions) {
        expect(action.eligible).toBe(false);
        expect(action.blockerCode).toBe("commercial_anchor_missing");
      }

      // Which is exactly what Q's own retained row says.
      const qRows = await retained(NOSTORE_BUSINESS, NOSTORE_Q);
      expect(
        qRows.map((row) => `${row.action}:${row.eligible}:${row.blocker_code}`),
      ).toEqual([
        "cut:false:commercial_anchor_missing",
        "refresh:false:commercial_anchor_missing",
        "scale:false:commercial_anchor_missing",
      ]);
    });

    it("keeps two currencies out of each other's anchor", async () => {
      const usd = await serve(FX_BUSINESS, FX_USD);
      const jpy = await serve(FX_BUSINESS, FX_JPY);

      /*
        RE-PINNED to the canonical basis, and the case is unchanged in what it
        measures. The USD account is anchored on its OWN Meta-attributed AOV —
        36.00 over 32 attributed purchases, a `ready` sample — not on the USD
        store's 58.00, which no longer sizes anything.
      */
      expect(usd.anchor.explanation?.spendUnitSource).toBe(
        "meta_derived_aov",
      );
      expect(usd.anchor.explanation?.spendUnit).toBeCloseTo(36 / 2.2, 9);

      // The JPY account has no Meta-attributed purchases of its own, so it
      // holds rather than inheriting the USD account's unit. (It never could
      // have inherited the USD STORE either: `resolveObservedShopifyAov`
      // refuses a currency it would have to convert.)
      expect(jpy.anchor.explanation?.spendUnit ?? null).toBeNull();
      expect(jpy.anchor.explanation?.spendUnitSource).toBe("insufficient");
      for (const action of jpy.anchor.actions) {
        expect(action.eligible).toBe(false);
        expect(action.blockerCode).toBe("commercial_anchor_missing");
      }
    });

    it("pins what a currency outside the minor-unit registry yields", async () => {
      const { resolveMinorUnitExponent } = await import(
        "@/lib/currency/iso-4217-minor-units"
      );
      // The premise: KES really is a currency this registry does not carry, so
      // `resolveServeTimeObservedShopifyAov` passes `currencyExponent: null`.
      expect(resolveMinorUnitExponent("KES").status).toBe("unknown_currency");

      const served = await serve(NOEXP_BUSINESS, NOEXP_ACCOUNT);
      const rows = await retained(NOEXP_BUSINESS, NOEXP_ACCOUNT);

      /*
        RE-PINNED, AND THE UNKNOWN EXPONENT NOW SETTLES NOTHING ABOUT THE UNIT.

        This case used to assert that a KES store's 58.00 round-tripped through
        `resolveObservedShopifyAov`'s two-decimal fallback and still produced
        58.00 / 2.20. That mattered while the store supplied the unit; it does
        not any more, because the store supplies no unit at all. The account's
        OWN Meta-attributed AOV does — 36.00 over 32 attributed purchases —
        and Meta's aggregate is in the account's currency with no exponent
        anywhere in its arithmetic (`computeMetaAttributedAov` divides revenue
        by conversions), so an unregistered currency cannot rescale it.

        What the case still pins, and what it was always for: the served answer
        and the account's own retained verdict agree for a currency outside the
        ISO minor-unit registry. `lib/meta/snapshot.ts` applies a stricter rule
        for the benchmark it writes in MINOR units (`currencyExponent !== null`),
        which is a real difference between two code paths and is reported rather
        than papered over here.
      */
      expect(served.anchor.explanation?.spendUnitSource).toBe(
        "meta_derived_aov",
      );
      expect(served.anchor.explanation?.spendUnit).toBeCloseTo(36 / 2.2, 9);
      expect(rows.length).toBe(3);
      for (const row of rows) {
        expect(Number(row.spend_unit)).toBeCloseTo(
          served.anchor.explanation!.spendUnit!,
          9,
        );
      }
    });

    it("serves the retention path's named hold for an uncovered account", async () => {
      // An account assigned AFTER the calibration pass: an ordinary production
      // state, and the one where a scoped read still answers (an empty funnel
      // pack and a live aggregate) without anything having been measured.
      await seedMetaAccount({
        businessId: SCOPE_BUSINESS,
        account: SCOPE_C,
        currency: "USD",
      });

      const produced = await produceRetained({
        businessId: SCOPE_BUSINESS,
        providerAccountId: SCOPE_C,
        asOfDate: AS_OF,
      });
      expect(Object.keys(produced.refusals)).toEqual([
        "account_calibration_scope_not_materialised",
      ]);
      expect(await retained(SCOPE_BUSINESS, SCOPE_C)).toEqual([]);

      const served = await serve(SCOPE_BUSINESS, SCOPE_C);
      // No verdict is served, and the reason carries the producer's own code.
      expect(served.anchor.status).toBe("unavailable");
      expect(served.anchor.actions).toEqual([]);
      for (const direction of ["increase", "decrease"] as const) {
        const availability = served.lineage[direction].availability as {
          status: string;
          reason: string;
        };
        expect(availability.status).toBe("output_not_retained");
        expect(availability.reason).toContain(
          "account_calibration_scope_not_materialised",
        );
        expect(served.lineage[direction].eligible ?? null).toBeNull();
      }

      /*
        And the hold lifts into a DIFFERENT hold the moment the pass covers the
        account — the producer answers, and its answer is C's own.

        RE-PINNED, and the reversal is the point. This used to assert that C —
        an account with zero measured purchases — became commercially anchored
        the instant calibration covered it, on the strength of the BUSINESS's
        store evidence, with cut and refresh eligible on a 26.36 unit derived
        from 58.00 / 2.20. Under the canonical rule that is exactly the
        substitution that must not happen: a Meta hard action is sized by META's
        attributed purchases for THIS account, C has none, so C holds outright.

        The subject of the case is untouched — the producer's refusal lifts, a
        verdict is retained, and it is C's own (measured lineage zero; B's 72
        mature creatives reach none of it). Only the verdict is stricter.
      */
      await calibrate(SCOPE_BUSINESS);
      const covered = await serve(SCOPE_BUSINESS, SCOPE_C);
      expect(covered.anchor.status).toBe("resolved");
      expect(covered.anchor.explanation?.spendUnitSource).toBe("insufficient");
      expect(covered.anchor.explanation?.spendUnit ?? null).toBeNull();
      expect(
        covered.anchor.explanation?.lineage.metaAttributedAovPurchaseCount90d,
      ).toBe(0);
      expect(covered.anchor.explanation?.lineage.accountCpaSampleCount).toBe(0);
      expect(
        covered.anchor.actions.map(
          (action) => `${action.action}:${action.eligible}:${action.blockerCode}`,
        ),
      ).toEqual([
        "scale:false:commercial_anchor_missing",
        "cut:false:commercial_anchor_missing",
        "refresh:false:commercial_anchor_missing",
      ]);
      // And C now has a retained verdict of its own that says the same thing.
      expect(
        (await produceRetained({
          businessId: SCOPE_BUSINESS,
          providerAccountId: SCOPE_C,
          asOfDate: AS_OF,
        })).refusals,
      ).toEqual({});
      expect(
        (await retained(SCOPE_BUSINESS, SCOPE_C)).map(
          (row) => `${row.action}:${row.eligible}:${row.blocker_code}`,
        ),
      ).toEqual([
        "cut:false:commercial_anchor_missing",
        "refresh:false:commercial_anchor_missing",
        "scale:false:commercial_anchor_missing",
      ]);
    });

    it("still anchors an account whose own Meta sample is ready", async () => {
      /*
        THE GUARD AGAINST OVER-CORRECTING, on real storage.

        Every re-pin above turns an `eligible_observed_shopify_aov` into a hold,
        so this case exists to prove the served path can still say YES — and
        through the canonical rung. P (NOSTORE_BUSINESS) has thirty-two of its
        own attributed purchases at 44.00, no Shopify store anywhere near it,
        and it resolves, agrees with its own retained rows, and demands nothing.
      */
      const served = await serve(NOSTORE_BUSINESS, NOSTORE_P);
      const rows = await retained(NOSTORE_BUSINESS, NOSTORE_P);

      expect(served.anchor.explanation?.status).toBe(
        "eligible_meta_derived_aov",
      );
      expect(served.anchor.explanation?.spendUnitSource).toBe(
        "meta_derived_aov",
      );
      expect(served.anchor.explanation?.thresholdEligible).toBe(true);
      expect(served.anchor.explanation?.missingInputs).toEqual([]);
      expect(served.anchor.explanation?.spendUnit).toBeCloseTo(44 / 2.2, 9);
      expect(rows.length).toBe(3);
      for (const row of rows) {
        expect(Number(row.spend_unit)).toBeCloseTo(
          served.anchor.explanation!.spendUnit!,
          9,
        );
      }
    });

    it("rejects an eligible retained row when only its strict canonical AOV facts move", async () => {
      const {
        readAccountProfileRetentionIdentity,
      } = await import("@/lib/meta/account-profile-output-producer");
      const { classifyRetainedProfile } = await import(
        "@/lib/meta/budget-readiness-retention"
      );
      const sql = db.getDb();
      const [retainedScale] = (await sql.query(
        `SELECT contract,
                profile_contract AS "profileContract",
                action,
                engine_epoch AS "engineEpoch",
                engine_version AS "engineVersion",
                input_fingerprint AS "inputFingerprint",
                source_fingerprint AS "sourceFingerprint",
                eligible,
                blocker_code AS "blockerCode",
                to_char(as_of_date, 'YYYY-MM-DD') AS "asOfDate",
                to_char(effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveAt",
                to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
           FROM engine_v3_account_profile_output
          WHERE business_id = $1
            AND provider_account_id = $2
            AND as_of_date = $3::date
            AND action = 'scale'
          ORDER BY recorded_at DESC
          LIMIT 1`,
        [NOSTORE_BUSINESS, NOSTORE_P, AS_OF],
      )) as Array<Record<string, unknown>>;
      expect(retainedScale).toMatchObject({ eligible: true, blockerCode: null });

      const beforeIdentity = await readAccountProfileRetentionIdentity({
        businessId: NOSTORE_BUSINESS,
        providerAccountId: NOSTORE_P,
        asOfDate: AS_OF,
      });
      expect(beforeIdentity).not.toBeNull();
      expect(
        classifyRetainedProfile(retainedScale, {
          ...beforeIdentity!,
          nowIso: new Date().toISOString(),
          maxAgeMs: 12 * 3_600_000,
        }),
      ).toEqual({ usable: true, reason: null });

      const [legacyBefore] = await sql.query<{ legacy_aov: string }>(
        `SELECT CONCAT_WS('|',
                  meta_attributed_aov_mean_90d::text,
                  meta_attributed_aov_purchase_count_90d::text,
                  meta_attributed_revenue_90d::text,
                  meta_aov_quality
                ) AS legacy_aov
           FROM engine_v3_account_calibration_daily
          WHERE business_id = $1
            AND scope_type = 'account'
            AND scope_id = $2
            AND campaign_kind = 'all'
            AND creative_format = 'overall'
            AND as_of_date = $3::date
          LIMIT 1`,
        [NOSTORE_BUSINESS, NOSTORE_P, AS_OF],
      );
      expect(legacyBefore?.legacy_aov).toBeTruthy();

      const changed = await sql.query<{ ad_id: string }>(
        `UPDATE meta_ad_daily
            SET validation_status = 'failed'
          WHERE business_id = $1
            AND provider_account_id = $2
            AND date = $3::date
            AND ad_id = (
              SELECT MIN(ad_id)
                FROM meta_ad_daily
               WHERE business_id = $1
                 AND provider_account_id = $2
                 AND date = $3::date
            )
          RETURNING ad_id`,
        [NOSTORE_BUSINESS, NOSTORE_P, AS_OF],
      );
      expect(changed).toHaveLength(1);

      try {
        const afterIdentity = await readAccountProfileRetentionIdentity({
          businessId: NOSTORE_BUSINESS,
          providerAccountId: NOSTORE_P,
          asOfDate: AS_OF,
        });
        expect(afterIdentity).not.toBeNull();
        expect(afterIdentity!.inputFingerprint).toBe(
          beforeIdentity!.inputFingerprint,
        );
        expect(afterIdentity!.sourceFingerprint).not.toBe(
          beforeIdentity!.sourceFingerprint,
        );
        expect(
          classifyRetainedProfile(retainedScale, {
            ...afterIdentity!,
            nowIso: new Date().toISOString(),
            maxAgeMs: 12 * 3_600_000,
          }),
        ).toEqual({
          usable: false,
          reason: "retained_profile_source_mismatch",
        });

        const [legacyAfter] = await sql.query<{ legacy_aov: string }>(
          `SELECT CONCAT_WS('|',
                    meta_attributed_aov_mean_90d::text,
                    meta_attributed_aov_purchase_count_90d::text,
                    meta_attributed_revenue_90d::text,
                    meta_aov_quality
                  ) AS legacy_aov
             FROM engine_v3_account_calibration_daily
            WHERE business_id = $1
              AND scope_type = 'account'
              AND scope_id = $2
              AND campaign_kind = 'all'
              AND creative_format = 'overall'
              AND as_of_date = $3::date
            LIMIT 1`,
          [NOSTORE_BUSINESS, NOSTORE_P, AS_OF],
        );
        expect(legacyAfter?.legacy_aov).toBe(legacyBefore!.legacy_aov);
      } finally {
        await sql.query(
          `UPDATE meta_ad_daily
              SET validation_status = 'passed'
            WHERE business_id = $1
              AND provider_account_id = $2
              AND date = $3::date
              AND ad_id = $4`,
          [NOSTORE_BUSINESS, NOSTORE_P, AS_OF, changed[0]!.ad_id],
        );
      }
    });

    it("contacted no network at all", () => {
      expect(fetchCalls).toEqual([]);
    });
  },
);
