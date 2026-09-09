// @vitest-environment node
//
// THE BOOTSTRAP MEASUREMENT POPULATION, DRIVEN AT THE REAL ROUTE, THE REAL
// RETENTION PRODUCER AND THE REAL BUDGET SOURCE LOADER.
//
// WHAT WAS WRONG. Scoping the commercial anchor to the selected ad account was
// right. The transitional state it opened was not. While no ad account of a
// business had a calibration scope of its own — every warehouse's state until
// the first run of the per-account writer that shipped in `058a1c8f6` —
// `resolveAccountProfileMeasurementScope` answered `per_account_scopes_unwritten`
// from the BUSINESS-POOLED population and let the verdict through:
// `accountProfileMeasuredScopeHold` returns `null` for that state, the producer
// read calibration with `providerAccountId: null`, and then persisted the
// resulting row under the requested PHYSICAL account id.
// `budget-proposal-source-loader.ts` and `budget-proposal-server-readers.ts`
// re-derived the identical pooled fingerprint and accepted the row.
//
// Labelling the answer `business_pooled` fixed the attribution copy and changed
// nothing about the authority. Measured at the real route on the fixture below
// — account A with 6 mature converters, its sibling B with 32, one business,
// no per-account scope anywhere — before the repair:
//
//   served  system.commercialAnchor.measurementScope.scope = "business_pooled"
//           …explanation.lineage.accountCpaSampleCount            = 38
//           …explanation.lineage.metaAttributedAovPurchaseCount90d = 38
//           …actions  scale:true:null | cut:true:null | refresh:true:null
//   retained engine_v3_account_profile_output for A, action 'scale'
//           eligible = true, blocker_code = null
//   budget   loadBudgetCompositionSourcesForCandidate(A, increase_budget)
//           commercial.eligible = true, profileRetained = true
//
// A has six mature converters. The automation-quality floor is thirty. Every
// one of those "true"s is B's evidence spent on A's account.
//
// WHAT THIS FILE PROVES, through the REAL exported route handler under a REAL
// session cookie, the REAL `produceRetainedAccountProfileOutputs` and the REAL
// `loadBudgetCompositionSourcesForCandidate`, against a REAL migrated ephemeral
// database:
//
//   (a) MULTI-ACCOUNT BOOTSTRAP. A is not granted scale from B — not in the
//       served profile, not in the retained row, and not in the budget
//       consumer. A reads its own six, and every action is withheld with the
//       resolver's own `commercial_anchor_sample_insufficient`.
//   (b) ADEQUATE DATA WORKS THROUGH BOOTSTRAP. An account with enough of its
//       OWN evidence is served a concrete answer in the same warehouse state —
//       no hold, no blanking, no waiting for a cron — and the retained verdict
//       and the budget consumer agree with it.
//
// THE COMMERCIAL BASIS, RE-PINNED. (a) and (b) used to assert
// `observed_shopify_aov` — the business's store AOV of 58.00 over the 2.20
// target ROAS, 26.36 — and (a) therefore blocked only Scale, on the calibration
// floor, while cut and refresh stayed eligible. That rung has been removed from
// `resolveSpendUnit`: for a META decision the hard-decision unit is META'S OWN
// attributed purchase AOV for this account divided by the target ROAS, and the
// merchant's settled Shopify orders are a different book. A's six attributed
// purchases are below the resolver's `ready` bar, so the commercial threshold
// itself is unmet and its blocker outranks the calibration one on all three
// actions. (b) is unchanged in kind — forty attributed purchases still resolve
// — which is what keeps (a) a statement about A's evidence rather than a
// blanket hold.
//   (c) NO BORROWED META AOV. An account with no purchases of its own, on a
//       business with no store, is told so rather than handed its sibling's
//       Meta-attributed average order value.
//   (d) THE BUDGET CONSUMER AGREES, and it agrees about the POPULATION: the
//       identity the loader materialises and the identity the execution reader
//       re-derives are the same value, and it is not the identity a pooled
//       reading of the same account and day would carry.
//   (e) THE MATERIALISED PATH IS UNCHANGED. One calibration run later every
//       answer above is identical, and moving only B moves nothing about A in
//       either state.
//   (f) THE POOLED BUSINESS SUMMARY IS STILL PUBLISHED AND STILL GRANTS
//       NOTHING. A request that names no physical account is labelled
//       `business_pooled`, and serving it retains no verdict for any account —
//       so nothing it says can reach a write. The budget consumer for a real
//       account inside the same business still refuses on that account's own
//       evidence.
//
// NOTHING IS MOCKED except the process-level absence of the network: no Meta
// connection is seeded, `globalThis.fetch` is replaced by a recorder that
// throws, and the test asserts it was never called. Every calibration row,
// every retained verdict and every served payload is produced by shipped code.
//
// HOW THE BOOTSTRAP STATE IS REACHED. The shipped calibration job is run, and
// then the account-named scope rows it wrote are deleted. What is left is
// byte-for-byte what the previous release's job produced: the pooled `'*'` rows
// are computed by the identical statement with the account parameter NULL, and
// the per-account rows simply did not exist. No fixture writes a calibration
// row by hand.
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
const DB_NAME = "adsecute_bootstrap_account_population";
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

const OWNER = "d0000000-0000-4000-8000-0000000009fd";

/**
 * Two accounts whose evidence differs materially — 6 mature converters against
 * 32 — so a pooled reading is a THIRD number that belongs to neither, and the
 * pooled one clears an automation floor that A's own six cannot.
 */
const BOOT_BUSINESS = "d0000000-0000-4000-8000-000000000921";
const BOOT_SMALL = "act_9200000000011";
const BOOT_LARGE = "act_9200000000012";
const BOOT_SHOP = "bootstrap-account-pooled.myshopify.test";

/** One account, ample evidence of its own, a covered store. */
const SOLE_BUSINESS = "d0000000-0000-4000-8000-000000000922";
const SOLE_ACCOUNT = "act_9200000000021";
const SOLE_SHOP = "bootstrap-account-sole.myshopify.test";

/** Two accounts, no store: the rung where a sibling's Meta AOV could be lent. */
const AOV_BUSINESS = "d0000000-0000-4000-8000-000000000923";
const AOV_WITH = "act_9200000000031";
const AOV_WITHOUT = "act_9200000000032";

function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

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
};

type ServedWorkspace = {
  anchor: {
    status: string;
    unavailableReason: string | null;
    measurementScope?: Record<string, unknown> | null;
    explanation: {
      status: string;
      spendUnit: number | null;
      spendUnitSource: string;
      thresholdEligible: boolean;
      missingInputs: string[];
      lineage: Record<string, unknown>;
    } | null;
    actions: AnchorAction[];
  };
  lineage: Record<"increase" | "decrease", Record<string, unknown>>;
  panel: Record<"increase" | "decrease", Record<string, unknown>>;
  measurementScope: Record<"increase" | "decrease", unknown>;
};

type RetainedVerdict = {
  action: string;
  eligible: boolean;
  blocker_code: string | null;
  spend_unit: string | null;
  input_fingerprint: string;
  source_fingerprint: string;
};

let dataDir = "";
let started = false;
let pgCtl = "";
const fetchCalls: string[] = [];

describe.skipIf(!RUNNABLE)(
  "the measurement population before any per-account calibration scope exists",
  () => {
    let db: typeof import("@/lib/db");
    let sessionCookie = "";
    let route: typeof import("@/app/api/meta/decisions-workspace/route");
    let producer: typeof import("@/lib/meta/account-profile-output-producer");
    let loadBudgetSources: typeof import("@/lib/meta/budget-proposal-source-loader").loadBudgetCompositionSourcesForCandidate;
    let calibrate: (businessId: string) => Promise<void>;
    let seedCreatives: (input: {
      businessId: string;
      account: string;
      count: number;
      offset: number;
      spend: number;
      revenue: number;
      conversions?: number;
      currency: string;
    }) => Promise<void>;

    /** The real route handler, with or without a physical account named. */
    const serve = async (
      businessId: string,
      account: string | null,
    ): Promise<ServedWorkspace> => {
      const accountParam =
        account === null ? "" : `&providerAccountId=${account}`;
      const response = await route.GET(
        new NextRequest(
          `http://localhost/api/meta/decisions-workspace?businessId=${businessId}${accountParam}&window=28d`,
          { headers: { cookie: sessionCookie } },
        ),
      );
      const payload = (await response.json()) as Record<string, any>;
      if (response.status !== 200) {
        throw new Error(
          `route ${response.status} for ${account ?? "business-wide"}: ${JSON.stringify(payload).slice(0, 500)}`,
        );
      }
      return {
        anchor: payload.system.commercialAnchor,
        lineage: {
          increase: payload.system.budgetEvidence.increase.commercialLineage,
          decrease: payload.system.budgetEvidence.decrease.commercialLineage,
        },
        panel: {
          increase: payload.system.budgetEvidence.increase,
          decrease: payload.system.budgetEvidence.decrease,
        },
        measurementScope: {
          increase: payload.system.budgetEvidence.increase.measurementScope,
          decrease: payload.system.budgetEvidence.decrease.measurementScope,
        },
      };
    };

    const retained = async (
      businessId: string,
      account: string,
    ): Promise<RetainedVerdict[]> =>
      (await db.getDb().query(
        `SELECT action, eligible, blocker_code, spend_unit::text AS spend_unit,
                input_fingerprint, source_fingerprint
           FROM engine_v3_account_profile_output
          WHERE business_id = $1 AND provider_account_id = $2 AND as_of_date = $3::date
          ORDER BY action, source_fingerprint`,
        [businessId, account, AS_OF],
      )) as RetainedVerdict[];

    /** Every retained verdict of a business, whichever account it names. */
    const allRetained = async (businessId: string) =>
      (await db.getDb().query(
        `SELECT provider_account_id, action, eligible, blocker_code,
                source_fingerprint
           FROM engine_v3_account_profile_output
          WHERE business_id = $1
          ORDER BY provider_account_id, action, source_fingerprint`,
        [businessId],
      )) as Array<{
        provider_account_id: string;
        action: string;
        eligible: boolean;
        blocker_code: string | null;
        source_fingerprint: string;
      }>;

    /** The latest retained row per action, as `D086_PROFILE_LATEST_SQL` ranks. */
    const latestRetained = async (businessId: string, account: string) =>
      (await db.getDb().query(
        `SELECT DISTINCT ON (action) action, eligible, blocker_code, source_fingerprint
           FROM engine_v3_account_profile_output
          WHERE business_id = $1 AND provider_account_id = $2 AND as_of_date = $3::date
          ORDER BY action, recorded_at DESC, effective_at DESC`,
        [businessId, account, AS_OF],
      )) as Array<{
        action: string;
        eligible: boolean;
        blocker_code: string | null;
        source_fingerprint: string;
      }>;

    /**
     * The warehouse state a deploy of the per-account calibration writer lands
     * on: every pooled `scope_id '*'` row the previous release wrote, and no
     * account-named row at all, because the code that writes them shipped today
     * and no run has happened yet.
     */
    const dropPerAccountScopes = async (businessId: string) =>
      db.getDb().query(
        `DELETE FROM engine_v3_account_calibration_daily
          WHERE business_ref_id = $1::uuid
            AND scope_type = 'account'
            AND scope_id <> '*'`,
        [businessId],
      );

    const scopeRows = async (businessId: string) =>
      (await db.getDb().query(
        `SELECT DISTINCT scope_id
           FROM engine_v3_account_calibration_daily
          WHERE business_ref_id = $1::uuid AND scope_type = 'account'
          ORDER BY scope_id`,
        [businessId],
      )) as Array<{ scope_id: string }>;

    /**
     * The budget path's own view of one account, through the REAL loader.
     *
     * `loadBudgetCompositionSourcesForCandidate` is the first production
     * consumer of the retained verdict: it materialises the day's row through
     * `ensureRetainedAccountProfileOutputs`, re-derives the identity it expects,
     * classifies the row it finds and publishes the commercial verdict a budget
     * proposal is composed from. No provider contact is possible here — this
     * fixture persists no automation control row, and that gate is the only
     * door to a GET.
     */
    const budgetConsumerVerdict = async (
      businessId: string,
      account: string,
      direction: "increase_budget" | "decrease_budget",
    ) => {
      const sources = await loadBudgetSources({
        businessId,
        scopeType: "campaign",
        scopeId: `${account.replace(/\D/g, "")}01`,
        parentCampaignId: null,
        decisionAt: `${AS_OF}T09:00:00.000Z`,
        decisionHash: "bootstrap-account-population-candidate",
        providerAccountId: account,
        recId: "bootstrap-account-population-rec",
        recType: "budget_scale_guidance",
        snapshotDate: AS_OF,
        engineVersion: "test",
        decisionLabel: "bootstrap account population",
        recommendedAction: direction,
        targetAmountMinor: 27_500,
        reasoning: "seam",
        entityLabel: null,
        evidence: {},
      });
      return {
        profileRetained: sources?.profileRetained ?? null,
        commercial: (sources?.commercial ?? null) as {
          sourceStatus: string;
          selectedAction: string;
          eligible: boolean | null;
          code: string | null;
        } | null,
      };
    };

    beforeAll(async () => {
      const port = await freePort();
      if (FORBIDDEN_PORTS.has(port)) {
        throw new Error(`Refusing forbidden PostgreSQL port ${port}.`);
      }
      const bin = PG_BIN!;
      pgCtl = path.join(bin, "pg_ctl");
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-bap-"));
      dataDir = path.join(tempDir, "data");
      const socketDir = fs.mkdtempSync(path.join("/tmp", "bap-"));
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
      process.env.DATABASE_URL = databaseUrl;
      process.env.DATABASE_URL_UNPOOLED = databaseUrl;
      process.env.DB_SSL_MODE = "disable";
      process.env.META_DECISIONS_UPSTREAM_TRANSPORT = "in_process";

      db = await import("@/lib/db");
      const sql = db.getDb();
      await seedHealthyDbHostCapacitySnapshot(sql, "bootstrap-population-test-host");
      const { upsertMetaAdDailyRows, upsertMetaCreativeDailyRows } = await import(
        "@/lib/meta/warehouse"
      );
      const { runCalibrationJob } = await import(
        "@/lib/creative-decision-engine/jobs/calibration-job"
      );
      producer = await import("@/lib/meta/account-profile-output-producer");
      ({ loadBudgetCompositionSourcesForCandidate: loadBudgetSources } =
        await import("@/lib/meta/budget-proposal-source-loader"));

      calibrate = async (businessId: string) => {
        const job = await runCalibrationJob({ businessId, asOf: AS_OF });
        if (job.status !== "success") {
          throw new Error(
            `calibration job ${job.status} for ${businessId}: ${job.errorMessage ?? ""}`,
          );
        }
      };

      const seedMetaAccount = async (input: {
        businessId: string;
        account: string;
        currency: string;
      }) => {
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
        const conversions = input.conversions ?? 1;
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
              conversions,
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
           VALUES ($1, 'shopify', 'connected', $2, 'Bootstrap population store', now())
           RETURNING id::text AS id`,
          [input.businessId, input.shop],
        )) as Array<{ id: string }>;
        await sql.query(
          `INSERT INTO integration_credentials (provider_connection_id, access_token, metadata)
           VALUES ($1::uuid, 'bootstrap-population-token', $2::jsonb)`,
          [conn[0]!.id, JSON.stringify({ iana_timezone: "UTC" })],
        );
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
         VALUES ($1::uuid, 'bootstrap-population-seam@example.test', 'Bootstrap population seam', 'x')
         ON CONFLICT (id) DO NOTHING`,
        [OWNER],
      );

      // --- 6 against 32, one business, one store ---------------------------
      await seedBusiness(BOOT_BUSINESS, "Bootstrap pooled");
      for (const account of [BOOT_SMALL, BOOT_LARGE]) {
        await seedMetaAccount({
          businessId: BOOT_BUSINESS,
          account,
          currency: "USD",
        });
      }
      await seedCreatives({
        businessId: BOOT_BUSINESS,
        account: BOOT_SMALL,
        count: 6,
        offset: 0,
        spend: 10,
        revenue: 36,
        currency: "USD",
      });
      await seedCreatives({
        businessId: BOOT_BUSINESS,
        account: BOOT_LARGE,
        count: 32,
        offset: 0,
        spend: 10,
        revenue: 12,
        currency: "USD",
      });
      await seedShopifyStore({
        businessId: BOOT_BUSINESS,
        shop: BOOT_SHOP,
        currency: "USD",
        price: 58.0,
      });

      // --- one account, 40 converters of its own ---------------------------
      await seedBusiness(SOLE_BUSINESS, "Bootstrap sole account");
      await seedMetaAccount({
        businessId: SOLE_BUSINESS,
        account: SOLE_ACCOUNT,
        currency: "USD",
      });
      await seedCreatives({
        businessId: SOLE_BUSINESS,
        account: SOLE_ACCOUNT,
        count: 40,
        offset: 0,
        spend: 10,
        revenue: 36,
        currency: "USD",
      });
      await seedShopifyStore({
        businessId: SOLE_BUSINESS,
        shop: SOLE_SHOP,
        currency: "USD",
        price: 58.0,
      });

      // --- purchases on one account, none on the other, and no store -------
      await seedBusiness(AOV_BUSINESS, "Bootstrap AOV lending");
      for (const account of [AOV_WITH, AOV_WITHOUT]) {
        await seedMetaAccount({
          businessId: AOV_BUSINESS,
          account,
          currency: "USD",
        });
      }
      await seedCreatives({
        businessId: AOV_BUSINESS,
        account: AOV_WITH,
        count: 8,
        offset: 0,
        spend: 10,
        revenue: 44,
        currency: "USD",
      });
      await seedCreatives({
        businessId: AOV_BUSINESS,
        account: AOV_WITHOUT,
        count: 8,
        offset: 0,
        spend: 10,
        revenue: 0,
        conversions: 0,
        currency: "USD",
      });

      // The shipped job writes both scopes; deleting the account-named rows
      // leaves exactly what the previous release's job produced.
      for (const businessId of [BOOT_BUSINESS, SOLE_BUSINESS, AOV_BUSINESS]) {
        await calibrate(businessId);
        await dropPerAccountScopes(businessId);
      }

      const token = randomBytes(32).toString("hex");
      await sql.query(
        `INSERT INTO sessions (user_id, token_hash, active_business_id, expires_at)
         VALUES ($1::uuid, $2, $3::uuid, now() + interval '1 hour')`,
        [
          OWNER,
          createHash("sha256").update(token).digest("hex"),
          BOOT_BUSINESS,
        ],
      );
      sessionCookie = `omniads_session=${token}`;

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

    it("(a) does not grant A scale from B in bootstrap", async () => {
      // THE PREMISE, MEASURED: the per-account dimension really is absent, and
      // the pooled row the previous release wrote really is present.
      expect(
        (await scopeRows(BOOT_BUSINESS)).map((row) => row.scope_id),
      ).toEqual(["*"]);

      const served = await serve(BOOT_BUSINESS, BOOT_SMALL);

      // The measured lineage is A's OWN six. Pooled it was 38, and 38 clears
      // the thirty-creative automation-quality floor that six cannot.
      expect(served.anchor.status).toBe("resolved");
      expect(
        served.anchor.explanation?.lineage.accountCpaSampleCount,
      ).toBe(6);
      expect(
        served.anchor.explanation?.lineage.metaAttributedAovPurchaseCount90d,
      ).toBe(6);

      // The population is named as the ACCOUNT'S, and it says how it got there.
      expect(served.anchor.measurementScope).toMatchObject({
        materialisation: "per_account_scopes_unwritten",
        scope: "account",
        providerAccountId: BOOT_SMALL,
        basis: "account_runtime_aggregate",
        hold: null,
      });

      /*
        Every action is withheld with the resolver's own code — a concrete
        named answer, not a blanking.

        RE-PINNED. This used to read `scale:false:scale_calibration_below_floor`
        beside an eligible cut and refresh, because A's commercial anchor came
        from the business's Shopify AOV and only Scale answered to the
        calibration floor. The store rung is gone: A's unit is A's OWN
        Meta-attributed AOV, its six attributed purchases are below the `ready`
        bar, and the commercial threshold blocker outranks the calibration one
        for all three. A's calibration is still below the floor; it is simply no
        longer the FIRST reason.
      */
      expect(
        served.anchor.actions.map(
          (action) => `${action.action}:${action.eligible}:${action.blockerCode}`,
        ),
      ).toEqual([
        "scale:false:commercial_anchor_sample_insufficient",
        "cut:false:commercial_anchor_sample_insufficient",
        "refresh:false:commercial_anchor_sample_insufficient",
      ]);

      // THE RETAINED ROW SAYS THE SAME THING.
      const produced = await producer.produceRetainedAccountProfileOutputs({
        businessId: BOOT_BUSINESS,
        providerAccountId: BOOT_SMALL,
        asOfDate: AS_OF,
      });
      expect(produced.refusals).toEqual({});
      expect(produced.produced).toBe(true);
      expect(
        (await retained(BOOT_BUSINESS, BOOT_SMALL)).map(
          (row) => `${row.action}:${row.eligible}:${row.blocker_code}`,
        ),
      ).toEqual([
        "cut:false:commercial_anchor_sample_insufficient",
        "refresh:false:commercial_anchor_sample_insufficient",
        "scale:false:commercial_anchor_sample_insufficient",
      ]);

      // AND SO DOES THE BUDGET CONSUMER, which is the surface that authorises a
      // provider write. `eligible: null` is the loader's own encoding of "not
      // eligible"; the code beside it is the resolver's.
      const increase = await budgetConsumerVerdict(
        BOOT_BUSINESS,
        BOOT_SMALL,
        "increase_budget",
      );
      expect(increase.profileRetained).toBe(false);
      expect(increase.commercial).toMatchObject({
        selectedAction: "scale",
        sourceStatus: "unavailable",
        eligible: null,
        code: "commercial_anchor_sample_insufficient",
      });

      // The same consumer on the other direction, which A's own six-purchase
      // sample no longer supports either.
      const decrease = await budgetConsumerVerdict(
        BOOT_BUSINESS,
        BOOT_SMALL,
        "decrease_budget",
      );
      expect(decrease.commercial).toMatchObject({
        selectedAction: "cut",
        eligible: null,
        code: "commercial_anchor_sample_insufficient",
      });
    }, 180_000);

    it("(b) serves an adequately evidenced account a real answer in bootstrap", async () => {
      expect(
        (await scopeRows(SOLE_BUSINESS)).map((row) => row.scope_id),
      ).toEqual(["*"]);

      const served = await serve(SOLE_BUSINESS, SOLE_ACCOUNT);
      expect(served.anchor.status).toBe("resolved");
      expect(served.anchor.unavailableReason).toBeNull();
      /*
        RE-PINNED, and this case is where the guard against over-correcting
        lives on real storage: retiring the store rung must not leave the served
        path unable to say YES. It still says yes here, through the canonical
        rung — this account has forty of its own attributed purchases.
      */
      expect(served.anchor.explanation?.spendUnitSource).toBe(
        "meta_derived_aov",
      );
      // 36.00 Meta-attributed AOV / 2.20 target ROAS. ROAS is the only
      // configured target, and specifically NOT the store's 58.00 / 2.20.
      expect(served.anchor.explanation?.spendUnit).toBeCloseTo(36 / 2.2, 9);
      expect(served.anchor.explanation?.missingInputs).toEqual([]);
      expect(
        served.anchor.actions.map(
          (action) => `${action.action}:${action.eligible}:${action.blockerCode}`,
        ),
      ).toEqual(["scale:true:null", "cut:true:null", "refresh:true:null"]);

      /*
        AND THE POPULATION IS THIS ACCOUNT'S, PROVEN RATHER THAN ASSUMED.

        This business's warehouse holds rows for no other ad account, so the
        pooled rows the previous release computed ARE this account's rows. That
        equivalence is established from `meta_creative_daily` itself, which is
        why the reads may be served from the stable precomputed pooled row
        instead of a live aggregate — and why the label is `account` and not
        `business_pooled`.
      */
      expect(served.anchor.measurementScope).toMatchObject({
        materialisation: "per_account_scopes_unwritten",
        scope: "account",
        providerAccountId: SOLE_ACCOUNT,
        basis: "sole_account_pooled_rows",
        readProviderAccountId: null,
        hold: null,
      });

      const produced = await producer.produceRetainedAccountProfileOutputs({
        businessId: SOLE_BUSINESS,
        providerAccountId: SOLE_ACCOUNT,
        asOfDate: AS_OF,
      });
      expect(produced.refusals).toEqual({});
      expect(
        (await retained(SOLE_BUSINESS, SOLE_ACCOUNT)).map(
          (row) => `${row.action}:${row.eligible}:${row.blocker_code}`,
        ),
      ).toEqual(["cut:true:null", "refresh:true:null", "scale:true:null"]);

      const increase = await budgetConsumerVerdict(
        SOLE_BUSINESS,
        SOLE_ACCOUNT,
        "increase_budget",
      );
      expect(increase.profileRetained).toBe(true);
      expect(increase.commercial).toMatchObject({
        selectedAction: "scale",
        sourceStatus: "resolved",
        eligible: true,
        code: null,
      });
    }, 180_000);

    it("(b2) serves a healthy account its OWN answer through the runtime aggregate", async () => {
      /*
        THE CASE THAT SEPARATES CORRECT SCOPING FROM BLANKING.

        (b) proves an adequately evidenced account is not blanked, but it does
        so on the `sole_account_pooled_rows` basis — which reads the same
        precomputed row the previous release read, and therefore cannot detect
        a blanking caused by account scoping at all. (a) exercises the genuinely
        new `account_runtime_aggregate` path, but on an account whose own
        evidence is BELOW the floor, where a correct refusal and a blanking look
        identical.

        This is the missing corner: the new read path, on a multi-account
        business in bootstrap, for the account whose OWN evidence clears the
        floor. B has thirty-two converters of its own and must be served a
        concrete answer from them — not held, and not helped by A's six.
      */
      expect(
        (await scopeRows(BOOT_BUSINESS)).map((row) => row.scope_id),
      ).toEqual(["*"]);

      const served = await serve(BOOT_BUSINESS, BOOT_LARGE);

      expect(served.anchor.status).toBe("resolved");
      expect(served.anchor.unavailableReason).toBeNull();
      expect(served.anchor.measurementScope).toMatchObject({
        materialisation: "per_account_scopes_unwritten",
        scope: "account",
        providerAccountId: BOOT_LARGE,
        basis: "account_runtime_aggregate",
        hold: null,
      });

      // Its own thirty-two, not the pooled thirty-eight.
      expect(served.anchor.explanation?.lineage.accountCpaSampleCount).toBe(32);
      expect(
        served.anchor.explanation?.lineage.metaAttributedAovPurchaseCount90d,
      ).toBe(32);

      // Thirty-two clears the floor, so every action is granted — through the
      // read path that withheld Scale from A a moment ago.
      expect(
        served.anchor.actions.map(
          (action) => `${action.action}:${action.eligible}:${action.blockerCode}`,
        ),
      ).toEqual(["scale:true:null", "cut:true:null", "refresh:true:null"]);

      const produced = await producer.produceRetainedAccountProfileOutputs({
        businessId: BOOT_BUSINESS,
        providerAccountId: BOOT_LARGE,
        asOfDate: AS_OF,
      });
      expect(produced.refusals).toEqual({});
      expect(
        (await retained(BOOT_BUSINESS, BOOT_LARGE)).map(
          (row) => `${row.action}:${row.eligible}:${row.blocker_code}`,
        ),
      ).toEqual(["cut:true:null", "refresh:true:null", "scale:true:null"]);

      const increase = await budgetConsumerVerdict(
        BOOT_BUSINESS,
        BOOT_LARGE,
        "increase_budget",
      );
      expect(increase.profileRetained).toBe(true);
      expect(increase.commercial).toMatchObject({
        selectedAction: "scale",
        sourceStatus: "resolved",
        eligible: true,
        code: null,
      });
    }, 180_000);

    it("(c) lends no sibling's Meta AOV in bootstrap", async () => {
      const withPurchases = await serve(AOV_BUSINESS, AOV_WITH);
      const without = await serve(AOV_BUSINESS, AOV_WITHOUT);

      /*
        The account that has purchases reads its OWN 44.00 — which is the
        anti-pooling claim this case makes, and it is unchanged.

        ROUND 6: eight attributed purchases are below the `ready` bar of
        twenty, so under a Target ROAS the ladder holds rather than sizing a
        unit from them; the source is the hold and the lineage still names this
        account's own number. What must never appear here is the SIBLING's
        evidence, and it does not.
      */
      expect(withPurchases.anchor.explanation?.spendUnitSource).toBe(
        "insufficient",
      );
      expect(
        withPurchases.anchor.explanation?.lineage.metaAttributedAovMean90d,
      ).toBe(44);

      // The account that has none is told so. Pooled, it would have been handed
      // its sibling's 44 and anchored on evidence it never earned.
      expect(
        without.anchor.explanation?.lineage.metaAttributedAovMean90d ?? null,
      ).toBeNull();
      expect(without.anchor.explanation?.spendUnitSource).toBe("insufficient");
      for (const action of without.anchor.actions) {
        expect(action.eligible).toBe(false);
        expect(action.blockerCode).toBe("commercial_anchor_missing");
      }

      // And nothing eligible is retained for it either.
      await producer.produceRetainedAccountProfileOutputs({
        businessId: AOV_BUSINESS,
        providerAccountId: AOV_WITHOUT,
        asOfDate: AS_OF,
      });
      for (const row of await retained(AOV_BUSINESS, AOV_WITHOUT)) {
        expect(row.eligible).toBe(false);
        expect(row.blocker_code).toBe("commercial_anchor_missing");
      }
    }, 180_000);

    it("(d) makes both budget consumers expect the account's own population", async () => {
      /*
        The two consumers ask for the identity through two different entry
        points: the loader MATERIALISES the day's verdict and takes back the
        identity it must expect, and the execution reader RE-DERIVES the same
        identity without writing anything. They must be the same value, and it
        must not be the identity a pooled reading would carry.
      */
      const loaderIdentity =
        await producer.ensureRetainedAccountProfileOutputs({
          businessId: BOOT_BUSINESS,
          providerAccountId: BOOT_SMALL,
          asOfDate: AS_OF,
        });
      const executionIdentity =
        await producer.readAccountProfileRetentionIdentity({
          businessId: BOOT_BUSINESS,
          providerAccountId: BOOT_SMALL,
          asOfDate: AS_OF,
        });
      expect(loaderIdentity).not.toBeNull();
      expect(executionIdentity).toEqual(loaderIdentity);

      // The retained row the consumers read carries exactly that identity.
      const rows = await latestRetained(BOOT_BUSINESS, BOOT_SMALL);
      expect(rows.length).toBe(3);
      for (const row of rows) {
        expect(row.source_fingerprint).toBe(loaderIdentity!.sourceFingerprint);
      }

      /*
        AND IT IS NOT A POOLED FINGERPRINT THAT MERELY MATCHES.

        The facts the consumers expect are read here through the producer's own
        reader, and the pooled reading of the same business and day is read
        beside them through the shipped warehouse source. They are different
        numbers — 6 against 38 — and they digest to different values, so a row
        stamped with the pooled population cannot be accepted for this account.
        Before the repair it was the pooled reading that got stamped, and both
        consumers accepted it.
      */
      const accountInputs = await producer.readAccountProfileRetentionInputs({
        businessId: BOOT_BUSINESS,
        providerAccountId: BOOT_SMALL,
        asOfDate: AS_OF,
      });
      expect(accountInputs).not.toBeNull();
      expect(accountInputs!.accountCalibration.accountCpaSampleCount).toBe(6);
      const { WarehouseDataSource } = await import(
        "@/lib/creative-decision-engine/data-source"
      );
      const pooledCalibration = await new WarehouseDataSource().getAccountCalibration(
        { businessId: BOOT_BUSINESS, asOf: AS_OF },
      );
      expect(pooledCalibration.accountCpaSampleCount).toBe(38);
      const pooledIdentity = producer.accountProfileRetentionIdentity({
        ...accountInputs!,
        accountCalibration: pooledCalibration,
      });
      expect(pooledIdentity.sourceFingerprint).not.toBe(
        loaderIdentity!.sourceFingerprint,
      );
    }, 180_000);

    it("(e) reaches the identical answer once the pass has run, and never moves A for B", async () => {
      const before = await serve(BOOT_BUSINESS, BOOT_SMALL);
      const beforeRetained = await latestRetained(BOOT_BUSINESS, BOOT_SMALL);

      // Only B moves: forty more converters at a materially different revenue.
      await seedCreatives({
        businessId: BOOT_BUSINESS,
        account: BOOT_LARGE,
        count: 40,
        offset: 100,
        spend: 10,
        revenue: 200,
        currency: "USD",
      });
      const afterBMoved = await serve(BOOT_BUSINESS, BOOT_SMALL);
      expect(JSON.stringify(afterBMoved.anchor)).toBe(
        JSON.stringify(before.anchor),
      );

      // Now the pass runs, and every account gets a scope of its own.
      await calibrate(BOOT_BUSINESS);
      expect(
        (await scopeRows(BOOT_BUSINESS)).map((row) => row.scope_id),
      ).toEqual(["*", BOOT_SMALL, BOOT_LARGE].sort());

      const materialised = await serve(BOOT_BUSINESS, BOOT_SMALL);
      expect(materialised.anchor.measurementScope).toMatchObject({
        materialisation: "materialised",
        scope: "account",
        providerAccountId: BOOT_SMALL,
        basis: "materialised_account_scope",
        hold: null,
      });
      // The VERDICT is unchanged, because A's own evidence is unchanged. Only
      // the provenance moved.
      expect(
        materialised.anchor.actions.map(
          (action) => `${action.action}:${action.eligible}:${action.blockerCode}`,
        ),
      ).toEqual(
        before.anchor.actions.map(
          (action) => `${action.action}:${action.eligible}:${action.blockerCode}`,
        ),
      );
      expect(
        materialised.anchor.explanation?.lineage.accountCpaSampleCount,
      ).toBe(6);

      await producer.produceRetainedAccountProfileOutputs({
        businessId: BOOT_BUSINESS,
        providerAccountId: BOOT_SMALL,
        asOfDate: AS_OF,
      });
      const afterRetained = await latestRetained(BOOT_BUSINESS, BOOT_SMALL);
      expect(
        afterRetained.map((row) => `${row.action}:${row.eligible}:${row.blocker_code}`),
      ).toEqual(
        beforeRetained.map((row) => `${row.action}:${row.eligible}:${row.blocker_code}`),
      );
      // A bootstrap verdict and a materialised verdict are different EVIDENCE
      // even when they carry the same numbers, so they are different rows.
      expect(
        afterRetained[0]!.source_fingerprint,
      ).not.toBe(beforeRetained[0]!.source_fingerprint);
    }, 180_000);

    it("(f) still publishes the pooled business summary, and it authorises nothing", async () => {
      const summary = await serve(BOOT_BUSINESS, null);

      // A request that names no physical account is the business's whole Meta
      // footprint, and it says so.
      expect(summary.anchor.measurementScope).toMatchObject({
        scope: "business_pooled",
        providerAccountId: null,
        basis: "business_pooled_rows",
        hold: null,
      });

      // It is not an execution authority on either direction.
      for (const direction of ["increase", "decrease"] as const) {
        expect(summary.panel[direction].executionReadiness).toMatchObject({
          state: "not_executable",
          ctaEnabled: false,
        });
      }

      /*
        AND IT RETAINS NOTHING, which is the structural half.

        A commercial verdict only reaches a write through a row in
        `engine_v3_account_profile_output`, and every such row is keyed on one
        `provider_account_id`. Serving the summary leaves that table exactly as
        it was — no row for the business, no row under any account — so there is
        nothing for a consumer to look up by it.
      */
      const beforeRows = await allRetained(BOOT_BUSINESS);
      await serve(BOOT_BUSINESS, null);
      expect(await allRetained(BOOT_BUSINESS)).toEqual(beforeRows);
      for (const row of beforeRows) {
        expect([BOOT_SMALL, BOOT_LARGE]).toContain(row.provider_account_id);
      }

      // And it reaches no account inside the business: the budget consumer for
      // A still refuses on A's own six.
      const increase = await budgetConsumerVerdict(
        BOOT_BUSINESS,
        BOOT_SMALL,
        "increase_budget",
      );
      expect(increase.commercial).toMatchObject({
        eligible: null,
        code: "commercial_anchor_sample_insufficient",
      });
    }, 180_000);

    it("contacted no network at all", () => {
      expect(fetchCalls).toEqual([]);
    });
  },
);
