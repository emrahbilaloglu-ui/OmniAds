// @vitest-environment node
//
// THE PER-ACCOUNT CALIBRATION SCOPE TRANSITION, DRIVEN AT THE REAL ROUTE.
//
// WHAT WAS WRONG. Scoping the served commercial anchor to the selected ad
// account was right, and it opened a second road from "ample evidence" to a
// hold. The scoped probe reads `engine_v3_account_calibration_daily` at the
// ACCOUNT'S own `scope_id`, and nothing had ever written such a row: the writer
// shipped in `lib/creative-decision-engine/jobs/calibration-job.ts` at commit
// 058a1c8f6, so a warehouse that has not run the pass since then holds only the
// pooled `scope_id '*'` rows the previous release wrote. On deploy every
// account's panel would hold until the sync cron's next calibration run.
//
// Driven at the route in exactly that warehouse state — one ad account, 40
// mature converters, a covered Shopify store, the pooled row present and no
// account-named row anywhere — before the repair:
//
//   served   system.commercialAnchor.status            = "unavailable"
//                                    .unavailableReason = "profile_not_resolved"
//                                    .actions           = []
//            budgetEvidence.increase.commercialLineage.availability
//              = {status: "output_not_retained",
//                 reason: "account_calibration_scope_not_materialised: this ad
//                          account has no retained calibration scope of its own
//                          for <as-of> ..."}
//   producer refusals = {account_calibration_scope_not_materialised: [...]},
//            engine_v3_account_profile_output rows = []
//
// while the SAME account, one calibration run later, serves `resolved` with a
// spend unit of 26.36363636363636 (58.00 store AOV / 2.20 target ROAS) and all
// three actions eligible. Withholding was the defect: nothing about that
// account had changed.
//
// WHAT THIS FILE PROVES, through the REAL exported route handler under a REAL
// session cookie, against a REAL migrated ephemeral database:
//
//   1. TRANSITIONAL — no account of the business has a scope of its own. The
//      operator gets the usable answer back, and it is LABELLED: `scope:
//      "business_pooled"`, `providerAccountId: null`, on the anchor panel and
//      on both budget-evidence directions. The retention producer reaches the
//      same verdict from the same population instead of refusing, so the
//      response and the retained row agree.
//   2. The label is not sticky. One calibration run later the same account is
//      served `scope: "account"`, and the retained verdict is a NEW row with a
//      different source fingerprint — even though this single-account business's
//      pooled and account-scoped numbers are identical, which is the only thing
//      that could have let a pooled verdict masquerade as an account-scoped one.
//   3. GENUINE ABSENCE — sibling accounts have scopes and this one does not.
//      That is still the named hold, on the panel and in the producer's
//      refusals, and the sibling's own answer is untouched.
//   4. THE POOLED ANSWER REALLY IS POOLED, on a business that pools. An account
//      with 6 mature converters beside a sibling with 32 is served the pooled
//      38 in the transitional state — the reading the previous release served —
//      labelled `business_pooled`, with the retained verdict agreeing; and one
//      calibration run later it is served its own 6 and Scale is withheld with
//      the resolver's own `scale_calibration_below_floor`.
//   5. UNREADABLE — a probe that FAILED is not the fact that a scope is
//      missing. It holds under its own code with its own sentence, and neither
//      the code nor the sentence is the absent one's.
//
// NOTHING IS MOCKED except the process-level absence of the network: no Meta
// connection is seeded, `globalThis.fetch` is replaced by a recorder that
// throws, and the test asserts it was never called. Every calibration row,
// every retained verdict and every served payload is produced by shipped code —
// `runCalibrationJob`, `produceRetainedAccountProfileOutputs` and the route's
// own `GET`. The unreadable case renames the calibration relation for the
// duration of that one case and renames it back: the probe then raises a real
// error from a real statement, which is the observable event the pool's 8s
// query ceiling produces, rather than a stubbed reader.
//
// HOW THE TRANSITIONAL STATE IS REACHED. The shipped calibration job is run,
// and then the account-named scope rows it wrote are deleted. What is left is
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

/** Never the local volume, never the production tunnel. */
const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB_NAME = "adsecute_anchor_scope_transition";
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

const OWNER = "d0000000-0000-4000-8000-0000000009fe";

/** One account, ample evidence, a covered store: the deploy-day case. */
const SOLO_BUSINESS = "d0000000-0000-4000-8000-000000000911";
const SOLO_ACCOUNT = "act_9100000000011";
const SOLO_SHOP = "anchor-scope-transition-solo.myshopify.test";

/** Two accounts: one covered by the pass, one not. */
const SIB_BUSINESS = "d0000000-0000-4000-8000-000000000912";
const SIB_COVERED = "act_9100000000021";
const SIB_UNCOVERED = "act_9100000000022";
const SIB_SHOP = "anchor-scope-transition-sib.myshopify.test";

/**
 * Two accounts whose evidence differs materially — 6 converters against 32 —
 * so the pooled reading is a THIRD number that belongs to neither. This is the
 * fixture the original account-scope defect was found on, and it is what makes
 * "the transitional answer really is pooled" observable rather than asserted.
 */
const POOL_BUSINESS = "d0000000-0000-4000-8000-000000000913";
const POOL_SMALL = "act_9100000000031";
const POOL_LARGE = "act_9100000000032";
const POOL_SHOP = "anchor-scope-transition-pool.myshopify.test";

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
    measurementScope?: Record<string, unknown>;
    explanation: {
      status: string;
      spendUnit: number | null;
      spendUnitSource: string;
      lineage: Record<string, unknown>;
    } | null;
    actions: AnchorAction[];
  };
  lineage: Record<"increase" | "decrease", Record<string, unknown>>;
  measurementScope: Record<"increase" | "decrease", unknown>;
};

type RetainedVerdict = {
  action: string;
  eligible: boolean;
  blocker_code: string | null;
  spend_unit: string | null;
  source_fingerprint: string;
};

let dataDir = "";
let started = false;
let pgCtl = "";
const fetchCalls: string[] = [];

describe.skipIf(!RUNNABLE)(
  "the anchor across the per-account calibration scope transition",
  () => {
    let db: typeof import("@/lib/db");
    let sessionCookie = "";
    let route: typeof import("@/app/api/meta/decisions-workspace/route");
    let produceRetained: typeof import("@/lib/meta/account-profile-output-producer").produceRetainedAccountProfileOutputs;
    let calibrate: (businessId: string) => Promise<void>;

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
                source_fingerprint
           FROM engine_v3_account_profile_output
          WHERE business_id = $1 AND provider_account_id = $2 AND as_of_date = $3::date
          ORDER BY action, source_fingerprint`,
        [businessId, account, AS_OF],
      )) as RetainedVerdict[];

    /**
     * The warehouse state a deploy of the per-account calibration writer lands
     * on: every pooled `scope_id '*'` row the previous release wrote, and no
     * account-named row at all, because the code that writes them shipped today
     * and no run has happened yet.
     */
    const dropPerAccountScopes = async (businessId: string, only?: string) =>
      db.getDb().query(
        `DELETE FROM engine_v3_account_calibration_daily
          WHERE business_ref_id = $1::uuid
            AND scope_type = 'account'
            AND scope_id <> '*'
            AND ($2::text IS NULL OR scope_id = $2::text)`,
        [businessId, only ?? null],
      );

    const scopeRows = async (businessId: string) =>
      (await db.getDb().query(
        `SELECT DISTINCT scope_id
           FROM engine_v3_account_calibration_daily
          WHERE business_ref_id = $1::uuid AND scope_type = 'account'
          ORDER BY scope_id`,
        [businessId],
      )) as Array<{ scope_id: string }>;

    beforeAll(async () => {
      const port = await freePort();
      if (FORBIDDEN_PORTS.has(port)) {
        throw new Error(`Refusing forbidden PostgreSQL port ${port}.`);
      }
      const bin = PG_BIN!;
      pgCtl = path.join(bin, "pg_ctl");
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-ast-"));
      dataDir = path.join(tempDir, "data");
      const socketDir = fs.mkdtempSync(path.join("/tmp", "ast-"));
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
      const { upsertMetaCreativeDailyRows } = await import(
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

      const seedCreatives = async (input: {
        businessId: string;
        account: string;
        count: number;
        offset: number;
        spend: number;
        revenue: number;
        currency: string;
      }) => {
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
           VALUES ($1, 'shopify', 'connected', $2, 'Anchor scope store', now())
           RETURNING id::text AS id`,
          [input.businessId, input.shop],
        )) as Array<{ id: string }>;
        await sql.query(
          `INSERT INTO integration_credentials (provider_connection_id, access_token, metadata)
           VALUES ($1::uuid, 'anchor-scope-token', $2::jsonb)`,
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
         VALUES ($1::uuid, 'anchor-scope-seam@example.test', 'Anchor scope seam', 'x')
         ON CONFLICT (id) DO NOTHING`,
        [OWNER],
      );

      // --- one account, 40 mature converters, a covered store -------------
      await seedBusiness(SOLO_BUSINESS, "Anchor scope solo");
      await seedMetaAccount({
        businessId: SOLO_BUSINESS,
        account: SOLO_ACCOUNT,
        currency: "USD",
      });
      await seedCreatives({
        businessId: SOLO_BUSINESS,
        account: SOLO_ACCOUNT,
        count: 40,
        offset: 0,
        spend: 10,
        revenue: 36,
        currency: "USD",
      });
      await seedShopifyStore({
        businessId: SOLO_BUSINESS,
        shop: SOLO_SHOP,
        currency: "USD",
        price: 58.0,
      });

      // --- two accounts, both with evidence -------------------------------
      await seedBusiness(SIB_BUSINESS, "Anchor scope siblings");
      for (const account of [SIB_COVERED, SIB_UNCOVERED]) {
        await seedMetaAccount({
          businessId: SIB_BUSINESS,
          account,
          currency: "USD",
        });
      }
      await seedCreatives({
        businessId: SIB_BUSINESS,
        account: SIB_COVERED,
        count: 40,
        offset: 0,
        spend: 10,
        revenue: 36,
        currency: "USD",
      });
      await seedCreatives({
        businessId: SIB_BUSINESS,
        account: SIB_UNCOVERED,
        count: 40,
        offset: 0,
        spend: 10,
        revenue: 36,
        currency: "USD",
      });
      await seedShopifyStore({
        businessId: SIB_BUSINESS,
        shop: SIB_SHOP,
        currency: "USD",
        price: 58.0,
      });

      // --- two accounts whose evidence differs, so pooling is visible -----
      await seedBusiness(POOL_BUSINESS, "Anchor scope pooled");
      for (const account of [POOL_SMALL, POOL_LARGE]) {
        await seedMetaAccount({
          businessId: POOL_BUSINESS,
          account,
          currency: "USD",
        });
      }
      await seedCreatives({
        businessId: POOL_BUSINESS,
        account: POOL_SMALL,
        count: 6,
        offset: 0,
        spend: 10,
        revenue: 36,
        currency: "USD",
      });
      await seedCreatives({
        businessId: POOL_BUSINESS,
        account: POOL_LARGE,
        count: 32,
        offset: 0,
        spend: 10,
        revenue: 12,
        currency: "USD",
      });
      await seedShopifyStore({
        businessId: POOL_BUSINESS,
        shop: POOL_SHOP,
        currency: "USD",
        price: 58.0,
      });

      for (const businessId of [SOLO_BUSINESS, SIB_BUSINESS, POOL_BUSINESS]) {
        await calibrate(businessId);
      }

      const token = randomBytes(32).toString("hex");
      await sql.query(
        `INSERT INTO sessions (user_id, token_hash, active_business_id, expires_at)
         VALUES ($1::uuid, $2, $3::uuid, now() + interval '1 hour')`,
        [
          OWNER,
          createHash("sha256").update(token).digest("hex"),
          SOLO_BUSINESS,
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

    it("serves and retains a pooled answer, labelled, while no account has a scope", async () => {
      // THE PREMISE, MEASURED: this account's own scope really was written, and
      // the answer it produces is the one the operator is entitled to.
      expect((await scopeRows(SOLO_BUSINESS)).map((row) => row.scope_id)).toEqual([
        "*",
        SOLO_ACCOUNT,
      ]);
      const materialised = await serve(SOLO_BUSINESS, SOLO_ACCOUNT);
      expect(materialised.anchor.status).toBe("resolved");
      expect(materialised.anchor.explanation?.spendUnit).toBeCloseTo(26.363636, 5);

      // The warehouse a deploy of the per-account writer lands on: the pooled
      // rows the previous release wrote, and nothing account-named at all.
      await dropPerAccountScopes(SOLO_BUSINESS);
      expect((await scopeRows(SOLO_BUSINESS)).map((row) => row.scope_id)).toEqual([
        "*",
      ]);

      const served = await serve(SOLO_BUSINESS, SOLO_ACCOUNT);

      // 1. THE OPERATOR STILL GETS THE ANSWER. Same number, same three actions.
      expect(served.anchor.status).toBe("resolved");
      expect(served.anchor.unavailableReason).toBeNull();
      expect(served.anchor.explanation?.spendUnitSource).toBe(
        "observed_shopify_aov",
      );
      expect(served.anchor.explanation?.spendUnit).toBeCloseTo(26.363636, 5);
      expect(
        served.anchor.actions.map(
          (action) => `${action.action}:${action.eligible}:${action.blockerCode}`,
        ),
      ).toEqual(["scale:true:null", "cut:true:null", "refresh:true:null"]);

      // 2. AND IT SAYS WHAT IT IS. Not an account-scoped measurement.
      expect(served.anchor.measurementScope).toMatchObject({
        contractVersion: "meta.account-profile-measurement-scope.v1",
        materialisation: "per_account_scopes_unwritten",
        scope: "business_pooled",
        providerAccountId: null,
        hold: null,
      });
      expect(String(served.anchor.measurementScope?.why)).toContain(
        "no ad account of this business has a calibration scope of its own",
      );

      // 3. ON EVERY SURFACE THAT CARRIES THE NUMBER. A budget increase is
      //    authorised from these panels, so the label travels with them.
      for (const direction of ["increase", "decrease"] as const) {
        expect(served.measurementScope[direction]).toEqual(
          served.anchor.measurementScope,
        );
        expect(served.lineage[direction]).toMatchObject({
          availability: { status: "resolved" },
        });
      }

      // 4. AND THE RETAINED VERDICT AGREES, instead of refusing. Same
      //    eligibility, same blocker codes, same spend unit, from the same
      //    population — which is the contradiction this whole round exists to
      //    remove, in the direction that would otherwise have been recreated.
      const produced = await produceRetained({
        businessId: SOLO_BUSINESS,
        providerAccountId: SOLO_ACCOUNT,
        asOfDate: AS_OF,
      });
      expect(produced.refusals).toEqual({});
      expect(produced.produced).toBe(true);
      const rows = await retained(SOLO_BUSINESS, SOLO_ACCOUNT);
      expect(
        rows.map((row) => `${row.action}:${row.eligible}:${row.blocker_code}`),
      ).toEqual(["cut:true:null", "refresh:true:null", "scale:true:null"]);
      for (const row of rows) {
        expect(Number(row.spend_unit)).toBeCloseTo(
          served.anchor.explanation!.spendUnit!,
          9,
        );
      }
    }, 180_000);

    it("stops serving the pooled answer the moment the account has its own scope", async () => {
      const pooledRows = await retained(SOLO_BUSINESS, SOLO_ACCOUNT);
      expect(pooledRows).toHaveLength(3);

      await calibrate(SOLO_BUSINESS);
      expect((await scopeRows(SOLO_BUSINESS)).map((row) => row.scope_id)).toEqual([
        "*",
        SOLO_ACCOUNT,
      ]);

      const served = await serve(SOLO_BUSINESS, SOLO_ACCOUNT);
      expect(served.anchor.status).toBe("resolved");
      expect(served.anchor.measurementScope).toMatchObject({
        materialisation: "materialised",
        scope: "account",
        providerAccountId: SOLO_ACCOUNT,
        hold: null,
      });
      for (const direction of ["increase", "decrease"] as const) {
        expect(served.measurementScope[direction]).toEqual(
          served.anchor.measurementScope,
        );
      }

      /*
        AND THE RETAINED SIDE STOPS TOO, which is the harder half.

        This business owns one ad account, so its pooled calibration and its
        account-scoped calibration are the same NUMBERS: nothing in the measured
        values could distinguish the two verdicts. The identity carries the
        measurement scope itself, so the account-scoped verdict is a different
        row rather than a re-observation of the pooled one — three new rows
        beside the three that already existed, with fingerprints that share
        nothing.
      */
      await produceRetained({
        businessId: SOLO_BUSINESS,
        providerAccountId: SOLO_ACCOUNT,
        asOfDate: AS_OF,
      });
      const afterRows = await retained(SOLO_BUSINESS, SOLO_ACCOUNT);
      expect(afterRows).toHaveLength(6);
      const pooledFingerprints = new Set(
        pooledRows.map((row) => row.source_fingerprint),
      );
      const scopedFingerprints = new Set(
        afterRows
          .map((row) => row.source_fingerprint)
          .filter((fingerprint) => !pooledFingerprints.has(fingerprint)),
      );
      expect(scopedFingerprints.size).toBe(1);
      expect(pooledFingerprints.size).toBe(1);

      /*
        AND IT IS THE SCOPED ONE THAT READS AS CURRENT.

        `D086_PROFILE_LATEST_SQL` (lib/meta/budget-readiness-read-model.ts)
        ranks per action by `recorded_at DESC, effective_at DESC`, so "the
        pooled verdict stops being served" is a claim about which row that
        ordering picks. It picks the account-scoped one.
      */
      const newest = (await db.getDb().query(
        `SELECT source_fingerprint
           FROM engine_v3_account_profile_output
          WHERE business_id = $1 AND provider_account_id = $2
            AND as_of_date = $3::date AND action = 'scale'
          ORDER BY recorded_at DESC, effective_at DESC
          LIMIT 1`,
        [SOLO_BUSINESS, SOLO_ACCOUNT, AS_OF],
      )) as Array<{ source_fingerprint: string }>;
      expect(scopedFingerprints.has(newest[0]!.source_fingerprint)).toBe(true);
      // The verdict itself is unchanged, because the account's own evidence is
      // the same evidence. Only its provenance moved.
      expect(
        afterRows.map((row) => `${row.action}:${row.eligible}:${row.blocker_code}`),
      ).toEqual([
        "cut:true:null",
        "cut:true:null",
        "refresh:true:null",
        "refresh:true:null",
        "scale:true:null",
        "scale:true:null",
      ]);
    }, 180_000);

    it("still holds by name for an account its siblings were measured without", async () => {
      // Only THIS account's scope is removed. The business keeps a materialised
      // per-account dimension, so the miss is a fact about the account.
      await dropPerAccountScopes(SIB_BUSINESS, SIB_UNCOVERED);
      expect((await scopeRows(SIB_BUSINESS)).map((row) => row.scope_id)).toEqual([
        "*",
        SIB_COVERED,
      ]);

      const served = await serve(SIB_BUSINESS, SIB_UNCOVERED);
      expect(served.anchor.status).toBe("unavailable");
      expect(served.anchor.actions).toEqual([]);
      expect(served.anchor.measurementScope).toMatchObject({
        materialisation: "absent",
        scope: "account",
        providerAccountId: SIB_UNCOVERED,
        hold: "account_calibration_scope_not_materialised",
      });
      for (const direction of ["increase", "decrease"] as const) {
        const availability = served.lineage[direction].availability as {
          status: string;
          reason: string;
        };
        expect(availability.status).toBe("output_not_retained");
        expect(availability.reason).toContain(
          "account_calibration_scope_not_materialised",
        );
        expect(availability.reason).toContain("skipped this account");
        expect(served.lineage[direction].eligible ?? null).toBeNull();
      }

      // The producer refuses the identical case under the identical name.
      const produced = await produceRetained({
        businessId: SIB_BUSINESS,
        providerAccountId: SIB_UNCOVERED,
        asOfDate: AS_OF,
      });
      expect(Object.keys(produced.refusals)).toEqual([
        "account_calibration_scope_not_materialised",
      ]);
      expect(await retained(SIB_BUSINESS, SIB_UNCOVERED)).toEqual([]);

      // And the sibling that WAS measured is unaffected by any of it.
      const covered = await serve(SIB_BUSINESS, SIB_COVERED);
      expect(covered.anchor.status).toBe("resolved");
      expect(covered.anchor.measurementScope).toMatchObject({
        materialisation: "materialised",
        scope: "account",
        providerAccountId: SIB_COVERED,
      });
      expect(covered.anchor.explanation?.spendUnit).toBeCloseTo(26.363636, 5);
    }, 180_000);

    it("names the pooled population as pooled on a business that really pools", async () => {
      /*
        THE ACCEPTED TRADE-OFF, MEASURED RATHER THAN ASSERTED.

        On a business with several ad accounts the transitional answer really is
        the pooled one: this account carries 6 mature converters and its sibling
        32, and the served lineage below reports 38. That is the reading the
        previous release served, and it is served again here ONLY because the
        per-account dimension does not exist yet — and only while wearing the
        `business_pooled` label. What must never happen is that number arriving
        dressed as this account's own measurement, or arriving without the
        retained verdict agreeing with it.
      */
      await dropPerAccountScopes(POOL_BUSINESS);
      expect((await scopeRows(POOL_BUSINESS)).map((row) => row.scope_id)).toEqual([
        "*",
      ]);

      const pooled = await serve(POOL_BUSINESS, POOL_SMALL);
      expect(pooled.anchor.status).toBe("resolved");
      expect(pooled.anchor.measurementScope).toMatchObject({
        materialisation: "per_account_scopes_unwritten",
        scope: "business_pooled",
        providerAccountId: null,
        hold: null,
      });
      // 6 + 32. The label is describing something true.
      expect(
        pooled.anchor.explanation?.lineage.metaAttributedAovPurchaseCount90d,
      ).toBe(38);
      expect(pooled.anchor.explanation?.lineage.accountCpaSampleCount).toBe(38);
      for (const direction of ["increase", "decrease"] as const) {
        expect(pooled.measurementScope[direction]).toEqual(
          pooled.anchor.measurementScope,
        );
      }

      // AND THE RETAINED VERDICT IS THE SAME VERDICT, read from the same
      // population — no second commercial truth for the same account and day.
      await produceRetained({
        businessId: POOL_BUSINESS,
        providerAccountId: POOL_SMALL,
        asOfDate: AS_OF,
      });
      const pooledRows = await retained(POOL_BUSINESS, POOL_SMALL);
      const servedByAction = new Map(
        pooled.anchor.actions.map((action) => [action.action, action]),
      );
      expect(pooledRows).toHaveLength(3);
      for (const row of pooledRows) {
        expect({
          eligible: row.eligible,
          blockerCode: row.blocker_code,
        }).toEqual({
          eligible: servedByAction.get(row.action)!.eligible,
          blockerCode: servedByAction.get(row.action)!.blockerCode,
        });
      }
      // Pooled, 38 samples clear the 30-creative automation-quality floor.
      expect(servedByAction.get("scale")!.eligible).toBe(true);

      /*
        ONE CALIBRATION RUN LATER the borrow is over. The same account is served
        its OWN six, and Scale is withheld with the resolver's own code — which
        is the round-four behaviour, reached the moment the evidence to reach it
        exists.
      */
      await calibrate(POOL_BUSINESS);
      const scoped = await serve(POOL_BUSINESS, POOL_SMALL);
      expect(scoped.anchor.measurementScope).toMatchObject({
        materialisation: "materialised",
        scope: "account",
        providerAccountId: POOL_SMALL,
      });
      expect(
        scoped.anchor.explanation?.lineage.metaAttributedAovPurchaseCount90d,
      ).toBe(6);
      expect(
        scoped.anchor.actions.map(
          (action) => `${action.action}:${action.eligible}:${action.blockerCode}`,
        ),
      ).toEqual([
        "scale:false:scale_calibration_below_floor",
        "cut:true:null",
        "refresh:true:null",
      ]);
      await produceRetained({
        businessId: POOL_BUSINESS,
        providerAccountId: POOL_SMALL,
        asOfDate: AS_OF,
      });
      const newest = (await db.getDb().query(
        `SELECT eligible, blocker_code
           FROM engine_v3_account_profile_output
          WHERE business_id = $1 AND provider_account_id = $2
            AND as_of_date = $3::date AND action = 'scale'
          ORDER BY recorded_at DESC, effective_at DESC
          LIMIT 1`,
        [POOL_BUSINESS, POOL_SMALL, AS_OF],
      )) as Array<{ eligible: boolean; blocker_code: string | null }>;
      expect(newest[0]).toEqual({
        eligible: false,
        blocker_code: "scale_calibration_below_floor",
      });
    }, 180_000);

    it("says an unreadable probe is unreadable, not absent", async () => {
      /*
        A probe that FAILS. `readAccountScopeCalibrationMaterialisation` is one
        statement against `engine_v3_account_calibration_daily`, and this
        repository has a documented hazard that kills such a read outright — the
        pool's own query timeout, which fires regardless of `statement_timeout`
        and lands silently. The relation is renamed for the duration of this
        case so the statement raises, which is the same observable event.
      */
      const absent = await serve(SIB_BUSINESS, SIB_UNCOVERED);
      await db.getDb().query(
        `ALTER TABLE engine_v3_account_calibration_daily
           RENAME TO engine_v3_account_calibration_daily_hidden`,
      );
      let served: ServedWorkspace;
      let produced: Awaited<ReturnType<typeof produceRetained>>;
      try {
        served = await serve(SOLO_BUSINESS, SOLO_ACCOUNT);
        produced = await produceRetained({
          businessId: SOLO_BUSINESS,
          providerAccountId: SOLO_ACCOUNT,
          asOfDate: AS_OF,
        });
      } finally {
        await db.getDb().query(
          `ALTER TABLE engine_v3_account_calibration_daily_hidden
             RENAME TO engine_v3_account_calibration_daily`,
        );
      }

      expect(served.anchor.status).toBe("unavailable");
      expect(served.anchor.measurementScope).toMatchObject({
        materialisation: "unreadable",
        scope: "account",
        providerAccountId: SOLO_ACCOUNT,
        hold: "account_calibration_scope_unreadable",
      });
      expect(Object.keys(produced.refusals)).toEqual([
        "account_calibration_scope_unreadable",
      ]);

      // BOTH REFUSE, AND THEY SAY DIFFERENT THINGS. The code differs, the
      // sentence differs, and the unreadable one does not claim the absence it
      // has no evidence for.
      const unreadableWhy = String(served.anchor.measurementScope?.why);
      const absentWhy = String(absent.anchor.measurementScope?.why);
      expect(unreadableWhy).not.toBe(absentWhy);
      expect(unreadableWhy).toContain("the calibration scope probe itself failed");
      expect(unreadableWhy).toContain("this is a failed read and not the fact");
      expect(unreadableWhy).not.toContain("skipped this account");
      expect(absentWhy).not.toContain("probe itself failed");
      for (const direction of ["increase", "decrease"] as const) {
        const availability = served.lineage[direction].availability as {
          status: string;
          reason: string;
        };
        expect(availability.reason).toContain(
          "account_calibration_scope_unreadable",
        );
        expect(availability.reason).not.toContain(
          "account_calibration_scope_not_materialised",
        );
      }

      // The rename really was undone, so nothing after this case is measuring a
      // broken database.
      expect((await scopeRows(SOLO_BUSINESS)).length).toBeGreaterThan(0);
    }, 180_000);

    it("contacted no network at all", () => {
      expect(fetchCalls).toEqual([]);
    });
  },
);
