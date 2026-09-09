// @vitest-environment node
//
// THE RETAINED PER-AD LATTICE IS ONE PHYSICAL ACCOUNT'S, THE SAME WAY THE
// SERVED COMMERCIAL ANCHOR NOW IS.
//
// WHAT WAS WRONG. `lib/creative-decision-engine/jobs/decisions-job.ts` and
// `lib/creative-decision-engine/jobs/lifecycle-job.ts` each resolved ONE
// account decision profile for the whole business and applied it to every
// creative. Every measured read `resolveAccountDecisionProfile` performs — the
// account calibration and its kind-segmented variants, the funnel pack, and the
// live Meta-attributed AOV it falls back to — defaults to the business's whole
// Meta footprint, so on a business holding two ad accounts each account's
// retained rows were computed from BOTH. The Decision Center then rendered an
// account-scoped anchor beside per-ad cards computed from pooled calibration.
//
// Driven at the shipped jobs before the fix, against a migrated database, with
// account A carrying six creatives at ROAS 3.60 and account B carrying
// thirty-two, and moving ONLY B's revenue:
//
//   A's retained engine_v3_decision_snapshots_daily.reason
//     before  "[near scale] ROAS 3.60 (28d) above commercial target (164%) -
//              spend 280 / purchases 28 below scale floor
//              (need spend >=14, >=30); observe."
//     after   "... (need spend >=76, >=30); observe."
//
// and, with only account Q's funnel counts moved on a second business:
//
//   P's retained engine_v3_creative_lifecycle_daily
//     funnel_primary_weak_stage   "none"  ->  "landing_page"
//     funnel_confidence            1      ->  0.8
//     site_responsibility_score    0      ->  1
//     funnel_evidence  ["funnel rates are not below account weak thresholds"]
//                   -> ["Link-to-ATC 25.00% vs account baseline 43.75%"]
//
// A's and P's own facts were untouched in both. The pooling also HID a hold:
// with B's thirty-two creatives padding the count, A was never told its own
// scale calibration was thin.
//
// WHAT THIS FILE PROVES, by running the shipped `runCalibrationJob`,
// `runLifecycleJob` and `runDecisionsJob` against a REAL migrated ephemeral
// database:
//
//   1. Account A's retained decision rows are byte-identical across a rerun in
//      which only account B's revenue moved, and B's own rows visibly move.
//   2. A's retained reason is A's OWN reading: it carries A's own six mature
//      creatives as a named calibration hold, a number the pooled thirty-eight
//      cannot produce.
//   3. Account P's retained lifecycle rows are byte-identical across a rerun in
//      which only account Q's funnel counts moved — while the pooled funnel
//      pack that fed the old business-wide profile visibly moves.
//   4. A creative whose warehouse rows name no account still gets a decision,
//      from the business-wide profile, because there is nothing else it could
//      honestly be scoped to.
//
// NOTHING IS MOCKED. Every calibration row, lifecycle row and decision snapshot
// is produced by shipped job code against this database.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedCanonicalMetaAdDailyFacts } from "@/lib/creative-decision-engine/meta-aov-calculator.test-helpers";

/** Never the local volume, never the production tunnel. */
const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB_NAME = "adsecute_profile_scope_callers";
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

const OWNER = "d0000000-0000-4000-8000-0000000009c0";

/** Two accounts, one business: the case the decisions defect lived in. */
const DECISIONS_BUSINESS = "d0000000-0000-4000-8000-0000000009c1";
const ACCOUNT_A = "act_9100000000011";
const ACCOUNT_B = "act_9100000000012";

/** Two accounts, one business: the case the lifecycle defect lived in. */
const LIFECYCLE_BUSINESS = "d0000000-0000-4000-8000-0000000009c2";
const ACCOUNT_P = "act_9200000000011";
const ACCOUNT_Q = "act_9200000000012";

function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** The last completed UTC day, which is the day every fixture speaks for. */
const AS_OF = addDays(new Date().toISOString().slice(0, 10), -1);

/** Enough history for the lifecycle age and active-day gates to open. */
const HISTORY_DAYS = 30;

type SeedCreatives = (input: {
  businessId: string;
  account: string;
  count: number;
  /** First ordinal, so one account can be seeded as several cohorts. */
  offset?: number;
  spend: number;
  revenue: number;
  linkClicks: number;
  landingPageViews: number;
  addToCart: number;
  initiateCheckout: number;
}) => Promise<void>;

let dataDir = "";
let started = false;
let pgCtl = "";

describe.skipIf(!RUNNABLE)(
  "the retained per-ad lattice is one physical account's",
  () => {
    let db: typeof import("@/lib/db");
    let seedCreatives: SeedCreatives;
    let runAllJobs: (businessId: string) => Promise<void>;

    /** One account's retained decision rows, exactly as stored. */
    const retainedDecisions = async (businessId: string, account: string) =>
      db.getDb().query(
        `SELECT s.creative_id, s.scope_type, s.scope_id, s.label, s.raw_label,
                s.pre_authority_label, s.authority_blocker, s.confidence,
                s.truth_source, s.effective_target_roas::text AS effective_target_roas,
                s.ratio_to_target::text AS ratio_to_target, s.badges, s.reason
           FROM engine_v3_decision_snapshots_daily s
           JOIN engine_v3_creative_lifecycle_daily l
             ON l.id = s.lifecycle_row_id
          WHERE s.business_id = $1
            AND s.as_of_date = $2::date
            AND l.provider_account_id = $3
          ORDER BY s.creative_id`,
        [businessId, AS_OF, account],
      );

    /** One account's retained lifecycle rows, exactly as stored. */
    const retainedLifecycle = async (businessId: string, account: string) =>
      db.getDb().query(
        `SELECT creative_id, funnel_primary_weak_stage, funnel_confidence,
                funnel_evidence, creative_responsibility_score,
                site_responsibility_score, checkout_responsibility_score,
                tracking_anomaly_score, fatigue_status, fatigue_confidence,
                fatigue_evidence
           FROM engine_v3_creative_lifecycle_daily
          WHERE business_id = $1
            AND as_of_date = $2::date
            AND provider_account_id = $3
          ORDER BY creative_id`,
        [businessId, AS_OF, account],
      );

    /**
     * One calibration scope's funnel percentile pack, as the calibration job
     * materialised it. `'*'` is the business's pooled scope — the one the
     * business-wide profile read — and a provider account id is that account's
     * own.
     */
    const funnelPack = async (businessId: string, scopeId: string) =>
      db.getDb().query(
        `SELECT creative_format, campaign_kind, funnel_sample_count,
                link_to_lpv_p25, link_to_lpv_p50, link_to_atc_p25,
                link_to_atc_p50, lpv_to_atc_p25, lpv_to_atc_p50,
                atc_to_ic_p25, atc_to_ic_p50
           FROM engine_v3_account_calibration_daily
          WHERE business_id = $1
            AND as_of_date = $2::date
            AND scope_type = 'account'
            AND scope_id = $3
          ORDER BY campaign_kind, creative_format`,
        [businessId, AS_OF, scopeId],
      );

    beforeAll(async () => {
      const port = await freePort();
      if (FORBIDDEN_PORTS.has(port)) {
        throw new Error(`Refusing forbidden PostgreSQL port ${port}.`);
      }
      const bin = PG_BIN!;
      pgCtl = path.join(bin, "pg_ctl");
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-psc-"));
      dataDir = path.join(tempDir, "data");
      // A SHORT socket directory: the data directory sits under the OS temp
      // path, and PostgreSQL's socket path limit is shorter than that.
      const socketDir = fs.mkdtempSync(path.join("/tmp", "psc-"));
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

      db = await import("@/lib/db");
      const sql = db.getDb();
      const { upsertMetaAdDailyRows, upsertMetaCreativeDailyRows } = await import(
        "@/lib/meta/warehouse"
      );
      const { runCalibrationJob } = await import("./jobs/calibration-job");
      const { runLifecycleJob } = await import("./jobs/lifecycle-job");
      const { runDecisionsJob } = await import("./jobs/decisions-job");

      runAllJobs = async (businessId: string) => {
        const calibration = await runCalibrationJob({
          businessId,
          asOf: AS_OF,
        });
        if (calibration.status !== "success") {
          throw new Error(
            `calibration ${calibration.status}: ${calibration.errorMessage ?? ""}`,
          );
        }
        const lifecycle = await runLifecycleJob({ businessId, asOf: AS_OF });
        if (lifecycle.status !== "success") {
          throw new Error(
            `lifecycle ${lifecycle.status}: ${lifecycle.errorMessage ?? ""}`,
          );
        }
        const decisions = await runDecisionsJob({ businessId, asOf: AS_OF });
        if (decisions.status !== "success") {
          throw new Error(
            `decisions ${decisions.status}: ${decisions.errorMessage ?? ""}`,
          );
        }
      };

      const seedBusiness = async (businessId: string, name: string) => {
        await sql.query(
          `INSERT INTO businesses (id, name, owner_id, timezone, currency, is_demo_business)
           VALUES ($1::uuid, $2, $3::uuid, 'UTC', 'USD', FALSE)
           ON CONFLICT (id) DO NOTHING`,
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
          their absence must never be a blocker. It also leaves the account's
          own Meta-attributed AOV as the money-per-purchase unit, which is what
          makes the measurement scope observable in the retained reason text.
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

      const seedAccount = async (businessId: string, account: string) => {
        const rows = (await sql.query(
          `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone)
           VALUES ('meta', $1, $1, 'USD', 'UTC')
           ON CONFLICT (provider, external_account_id)
           DO UPDATE SET currency = EXCLUDED.currency
           RETURNING id::text AS id`,
          [account],
        )) as Array<{ id: string }>;
        await sql.query(
          `INSERT INTO business_provider_accounts
             (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
           VALUES ($1, 'meta', $2::uuid, $3, 0, TRUE)
           ON CONFLICT (business_id, provider, provider_account_ref_id)
           DO UPDATE SET is_selected = TRUE`,
          [businessId, rows[0]!.id, account],
        );
      };

      seedCreatives = async (input) => {
        const digits = input.account.replace(/\D/g, "");
        // One day per batch: the dimension upsert behind
        // `upsertMetaCreativeDailyRows` refuses a batch that names the same
        // creative twice ("ON CONFLICT DO UPDATE command cannot affect row a
        // second time").
        for (let day = 0; day < HISTORY_DAYS; day += 1) {
          const rows = [];
          for (let index = 0; index < input.count; index += 1) {
            const ordinal = (input.offset ?? 0) + index;
            rows.push({
              businessId: input.businessId,
              providerAccountId: input.account,
              accountTimezone: "UTC",
              accountCurrency: "USD",
              sourceSnapshotId: null,
              date: addDays(AS_OF, -day),
              campaignId: `${digits}01`,
              adsetId: `${digits}02`,
              adId: `${digits}3${String(ordinal).padStart(3, "0")}`,
              creativeId: `${digits}4${String(ordinal).padStart(3, "0")}`,
              creativeName: `Creative ${ordinal}`,
              headline: null,
              primaryText: null,
              destinationUrl: null,
              thumbnailUrl: null,
              assetType: "image",
              objective: "OUTCOME_SALES",
              optimizationGoal: "OFFSITE_CONVERSIONS",
              effectiveStatus: "ACTIVE",
              spend: input.spend,
              revenue: input.revenue,
              conversions: 1,
              impressions: 1000,
              clicks: 10,
              reach: 800,
              linkClicks: input.linkClicks,
              frequency: 1000 / 800,
              roas: input.revenue / input.spend,
              cpa: input.spend,
              ctr: 1,
              cpc: input.spend / 10,
              payloadJson: {
                landing_page_views: input.landingPageViews,
                add_to_cart: input.addToCart,
                initiate_checkout: input.initiateCheckout,
                outbound_clicks: input.linkClicks,
              },
            });
          }
          await upsertMetaCreativeDailyRows(rows);
          await seedCanonicalMetaAdDailyFacts({
            sql,
            rows,
            write: upsertMetaAdDailyRows,
          });
        }
      };

      await sql.query(
        `INSERT INTO users (id, email, name, password_hash)
         VALUES ($1::uuid, 'profile-scope-callers@example.test', 'Profile scope callers', 'x')
         ON CONFLICT (id) DO NOTHING`,
        [OWNER],
      );

      // --- the decisions case ------------------------------------------
      await seedBusiness(DECISIONS_BUSINESS, "Profile scope decisions");
      await seedAccount(DECISIONS_BUSINESS, ACCOUNT_A);
      await seedAccount(DECISIONS_BUSINESS, ACCOUNT_B);
      /*
        Six mature creatives for A against thirty-two for B, at materially
        different revenue per conversion, so A's own reading, B's own reading
        and the pooled reading are three different numbers. The scale
        calibration floor is thirty, so A's own six can never clear it and A
        pooled with B always does.
      */
      await seedCreatives({
        businessId: DECISIONS_BUSINESS,
        account: ACCOUNT_A,
        count: 6,
        spend: 10,
        revenue: 36,
        linkClicks: 8,
        landingPageViews: 4,
        addToCart: 2,
        initiateCheckout: 1,
      });
      await seedCreatives({
        businessId: DECISIONS_BUSINESS,
        account: ACCOUNT_B,
        count: 32,
        spend: 10,
        revenue: 12,
        linkClicks: 8,
        landingPageViews: 4,
        addToCart: 2,
        initiateCheckout: 1,
      });

      // --- the lifecycle case ------------------------------------------
      await seedBusiness(LIFECYCLE_BUSINESS, "Profile scope lifecycle");
      await seedAccount(LIFECYCLE_BUSINESS, ACCOUNT_P);
      await seedAccount(LIFECYCLE_BUSINESS, ACCOUNT_Q);
      /*
        P and Q start with the SAME funnel shape, so the pooled pack and each
        account's own pack agree and the first reading cannot be attributed to
        either. Q is five times P's size, so once Q's counts move the pooled
        median follows Q and leaves P behind — which is exactly how P's rows
        were contaminated.
      */
      for (const account of [ACCOUNT_P, ACCOUNT_Q]) {
        await seedCreatives({
          businessId: LIFECYCLE_BUSINESS,
          account,
          count: account === ACCOUNT_P ? 6 : 32,
          spend: 10,
          revenue: 36,
          linkClicks: 8,
          landingPageViews: 4,
          addToCart: 2,
          initiateCheckout: 1,
        });
      }

      await runAllJobs(DECISIONS_BUSINESS);
      await runAllJobs(LIFECYCLE_BUSINESS);
    }, 600_000);

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

    it("retains account A's decisions from A's own calibration, not the pooled one", async () => {
      const rows = (await retainedDecisions(
        DECISIONS_BUSINESS,
        ACCOUNT_A,
      )) as Array<{ reason: string; label: string }>;

      // Six creatives, six retained rows. Their absence would make every
      // assertion below vacuous.
      expect(rows).toHaveLength(6);

      /*
        A'S OWN SAMPLE COUNT, NAMED. A has six mature creatives and B has
        thirty-two; the pooled calibration carries thirty-eight and clears the
        thirty-creative scale floor, so before the fix this hold was absent from
        every one of A's rows and the operator was never told A's own
        calibration is thin.
      */
      for (const row of rows) {
        expect(row.reason).toContain(
          "account scale calibration thin (6 mature creatives; need 30+)",
        );
        expect(row.reason).not.toContain("38 mature creatives");
      }
    });

    it("leaves account A's retained decisions byte-identical when only B moves", async () => {
      const beforeA = JSON.stringify(
        await retainedDecisions(DECISIONS_BUSINESS, ACCOUNT_A),
      );
      const beforeB = JSON.stringify(
        await retainedDecisions(DECISIONS_BUSINESS, ACCOUNT_B),
      );

      // ONLY B's revenue moves: 12 -> 92 per conversion, which nearly triples
      // the pooled Meta-attributed AOV behind the spend unit.
      await seedCreatives({
        businessId: DECISIONS_BUSINESS,
        account: ACCOUNT_B,
        count: 32,
        spend: 10,
        revenue: 92,
        linkClicks: 8,
        landingPageViews: 4,
        addToCart: 2,
        initiateCheckout: 1,
      });
      await runAllJobs(DECISIONS_BUSINESS);

      const afterA = JSON.stringify(
        await retainedDecisions(DECISIONS_BUSINESS, ACCOUNT_A),
      );
      const afterB = JSON.stringify(
        await retainedDecisions(DECISIONS_BUSINESS, ACCOUNT_B),
      );

      // B's own rows MUST move, or the fixture proved nothing about A.
      expect(afterB).not.toBe(beforeB);
      expect(afterA).toBe(beforeA);
    });

    it("leaves account P's retained lifecycle rows byte-identical when only Q moves", async () => {
      const beforeP = JSON.stringify(
        await retainedLifecycle(LIFECYCLE_BUSINESS, ACCOUNT_P),
      );
      const beforePooledPack = JSON.stringify(
        await funnelPack(LIFECYCLE_BUSINESS, "*"),
      );
      const beforePPack = JSON.stringify(
        await funnelPack(LIFECYCLE_BUSINESS, ACCOUNT_P),
      );
      expect(
        (await retainedLifecycle(LIFECYCLE_BUSINESS, ACCOUNT_P)) as unknown[],
      ).toHaveLength(6);

      // ONLY Q's funnel counts move, at every stage below the link click.
      // P's warehouse rows are not touched at all.
      await seedCreatives({
        businessId: LIFECYCLE_BUSINESS,
        account: ACCOUNT_Q,
        count: 32,
        spend: 10,
        revenue: 36,
        linkClicks: 8,
        landingPageViews: 8,
        addToCart: 7,
        initiateCheckout: 6,
      });
      await runAllJobs(LIFECYCLE_BUSINESS);

      /*
        THE PERTURBATION IS MATERIAL, AND IT IS MATERIAL IN THE POOLED PACK
        ONLY. Without this the byte-identity below could hold because nothing
        moved anywhere. The pooled `scope_id '*'` funnel percentiles are the
        exact channel the business-wide profile read, and they move; P's own
        scope, which the fix reads instead, does not.
      */
      expect(JSON.stringify(await funnelPack(LIFECYCLE_BUSINESS, "*"))).not.toBe(
        beforePooledPack,
      );
      expect(
        JSON.stringify(await funnelPack(LIFECYCLE_BUSINESS, ACCOUNT_P)),
      ).toBe(beforePPack);

      expect(
        JSON.stringify(await retainedLifecycle(LIFECYCLE_BUSINESS, ACCOUNT_P)),
      ).toBe(beforeP);
    });

    it("still decides a creative whose warehouse rows name no account", async () => {
      /*
        `meta_creative_daily.provider_account_id` is NOT NULL, so a creative
        with no account is one whose binding is blank rather than missing. Both
        readers behind the account lookup normalise a blank to absent, and the
        job must answer it from the business-wide profile rather than skip it:
        a creative without a decision is invisible to the operator.
      */
      const sql = db.getDb();
      const [orphan] = (await sql.query(
        `SELECT creative_id FROM meta_creative_daily
          WHERE business_id = $1 AND provider_account_id = $2
          ORDER BY creative_id LIMIT 1`,
        [DECISIONS_BUSINESS, ACCOUNT_A],
      )) as Array<{ creative_id: string }>;
      expect(orphan?.creative_id).toBeTruthy();

      await sql.query(
        `UPDATE engine_v3_creative_lifecycle_daily
            SET provider_account_id = ''
          WHERE business_id = $1 AND as_of_date = $2::date AND creative_id = $3`,
        [DECISIONS_BUSINESS, AS_OF, orphan!.creative_id],
      );
      await sql.query(
        `UPDATE meta_creative_daily
            SET provider_account_id = '  '
          WHERE business_id = $1 AND creative_id = $2`,
        [DECISIONS_BUSINESS, orphan!.creative_id],
      );

      const { runDecisionsJob } = await import("./jobs/decisions-job");
      const result = await runDecisionsJob({
        businessId: DECISIONS_BUSINESS,
        asOf: AS_OF,
      });
      expect(result.status).toBe("success");

      const [row] = (await sql.query(
        `SELECT label FROM engine_v3_decision_snapshots_daily
          WHERE business_id = $1 AND as_of_date = $2::date AND creative_id = $3`,
        [DECISIONS_BUSINESS, AS_OF, orphan!.creative_id],
      )) as Array<{ label: string }>;
      expect(row?.label).toBeTruthy();
    });
  },
);
