/**
 * A standing local fixture for the Decision Center's card-level Apply.
 *
 * WHY THIS EXISTS
 *
 * The card Apply was proved at the SQL seam
 * (`scripts/ephemeral-postgres-decision-card-apply-seam-child.ts`) and in
 * jsdom, and both are honest about what they grade: hydration, key derivation
 * and the preflight's target lookup. Neither mounts the product. The one thing
 * nobody had done was open the Decision Center in a browser with a populated
 * lane and press Apply, and the reason nobody had was that a populated lane is
 * expensive to arrange: `filterRowsToPublishedKeys` drops every warehouse row
 * whose `account:day` is not a PUBLISHED key, so an unpublished fixture reads
 * as an account with no campaigns, no ad sets, no census and no lane.
 *
 * The earlier attempt at this published 84 slices and still saw a census of
 * zero. The missing pieces were not slice count:
 *
 *   1. `getMetaPublishedVerificationSummary` requires a publication POINTER
 *      whose target slice is `status='published'` AND
 *      `state='finalized_verified'`. `createMetaAuthoritativeSliceVersion`
 *      writes the row; only `publishMetaAuthoritativeSliceVersion` moves the
 *      pointer. Both are called here.
 *   2. The census is `lanes.structureInventory`, which comes from
 *      `/api/meta/lane-classify` reading `getMetaCampaignsForRange` /
 *      `getMetaAdSetsForRange`. Those need BOTH `campaign_daily` AND
 *      `adset_daily` published for the SAME account-days, plus a Meta
 *      integration whose posture is `live` and an ASSIGNED, SELECTED provider
 *      account — an unselected `business_provider_accounts` row reads as no
 *      assigned account at all and short-circuits before the warehouse.
 *   3. The workspace's window is 28 days ending YESTERDAY (UTC), resolved by
 *      `resolveWorkspaceWindow`. A slice published for today is skipped as the
 *      account's current day and can never be a published key.
 *   4. The account-pulse upstream reads `account_daily`, which the previous
 *      fixture did not publish at all; `/api/meta/decisions-workspace` awaits
 *      both upstreams before it serves anything.
 *
 * WHAT IT DOES NOT DO
 *
 * It mints no decision. The recommendation the operator sees is produced by
 * `runMetaSnapshotForBusiness` from the seeded facts — the same production
 * function the scheduler calls. Seeding a `meta_decision_snapshots_daily` row
 * directly would prove the renderer against a payload the engine never wrote,
 * which is the exact failure mode this work exists to end.
 *
 * WHAT IT FOUND
 *
 * Running it showed that the card-level Apply cannot be reached by any
 * recommendation this engine produces. `proposedActionForRecommendation`
 * (`lib/meta/recommendations.ts`) grants an executable action only to an
 * `adset`-grain recommendation whose `type` is `bid_value_guidance`, and the
 * only emitter of that type — `maybeBidRecommendation` — builds a CAMPAIGN
 * recommendation. So `serverOperatorApplyForRec` returns null for every served
 * row, and the ceremony is never opened. The sized bid intent this fixture
 * produces (1200 → 1320 minor units) lands on
 * `scenario_e1_frequency_fatigue`, whose card offers "Review refresh plan".
 *
 * The same amount DOES reach an operator through the confirmation queue, and
 * that is the path this harness drives end to end: Approve & apply → the real
 * `/api/meta/adsets/<id>/apply-bid` route → a POST at the provider double →
 * the read-back → a durable receipt. Until the type gate above is repaired,
 * that queue is the only mounted route from a sized bid intent to a provider
 * write.
 *
 * SAFETY
 *
 * The cluster is a throwaway on a port that is never 5432 (local volume) or
 * 15432 (this machine's PRODUCTION tunnel, which `.env.local` points at).
 * `DATABASE_URL` is force-set on every child process: `@next/env` skips keys
 * that already exist in `process.env`, so the production URL in `.env.local`
 * can never win. Nothing here contacts a provider.
 *
 * USAGE
 *
 *   node --import tsx scripts/meta-decision-card-apply-harness.ts
 *   node --import tsx scripts/meta-decision-card-apply-harness.ts --stop
 *
 * See docs/qa/decision-card-apply-harness.md for the full browser recipe.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB_NAME = "adsecute_decision_card_apply";
const DB_USER = "postgres";
const OPERATOR_EMAIL = "harness-operator@adsecute.test";
const OPERATOR_PASSWORD = "decision-card-apply-harness";
const REVIEWER_EMAIL = "harness-reviewer@adsecute.test";

const BUSINESS = "b0000000-0000-4000-8000-0000000009a1";
const OPERATOR = "b0000000-0000-4000-8000-0000000009a2";
const REVIEWER = "b0000000-0000-4000-8000-0000000009a3";
const ACCOUNT = "act_9000000000001";

/*
 * Pure-digit entity ids.
 *
 * `META_PROVIDER_ENTITY_ID_PATTERN` is /^\d+$/ and gates every action-log
 * write, so a readable slug would prove the ceremony against an entity the
 * write path itself refuses. The `act_` prefix on the account is what Meta
 * uses and is correct.
 */
/**
 * The capped ad set the whole fixture exists for: a cost cap, twenty-seven
 * ordinary days and then a delivery collapse, which is the only evidence in
 * this product that a cap is holding delivery back.
 */
const CAPPED_CAMPAIGN = "9000000000101";
const CAPPED_ADSET = "9000000000201";
/**
 * A second budget owner, which is arithmetic rather than scenery: with one
 * owner the account concentration share is 1.0 and every sizing decision trips
 * the concentration limit. It is also the contrast case — a lowest-cost ad set
 * owns no writable cap and must earn no bid intent at all.
 */
const SECOND_CAMPAIGN = "9000000000102";
const SECOND_ADSET = "9000000000202";

const WINDOW_DAYS = 28;

function log(message: string) {
  console.log(`[decision-card-apply-harness] ${message}`);
}

function fail(message: string): never {
  throw new Error(`[decision-card-apply-harness] ${message}`);
}

function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/**
 * Yesterday in UTC, recomputed on every run.
 *
 * `/api/meta/decisions-workspace` anchors its metric window on
 * `previousUtcDate()` and `isMetaCurrentAccountDay` refuses to treat today as
 * published, so the fixture's newest day has to be yesterday. A literal date
 * would also drift out of `META_AUTHORITATIVE_HISTORY_DAYS` and flip the
 * campaign source into `historical_live_fallback`, which reads the live
 * provider.
 */
function resolveAsOf() {
  return addDays(new Date().toISOString().slice(0, 10), -1);
}

function resolvePgBinDir() {
  const override = process.env.EPHEMERAL_PG_BIN_DIR?.trim();
  const candidates = [
    ...(override ? [override] : []),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@16/bin",
    "/opt/homebrew/opt/postgresql@17/bin",
  ];
  for (const candidate of candidates) {
    if (["initdb", "pg_ctl", "postgres", "createdb"].every((tool) =>
      fs.existsSync(path.join(candidate, tool)),
    )) {
      return candidate;
    }
  }
  return fail(
    "No PostgreSQL bin directory found. Set EPHEMERAL_PG_BIN_DIR to a directory holding initdb/pg_ctl/postgres/createdb.",
  );
}

// Without a valid LC_ALL, macOS CoreFoundation locale initialization makes
// initdb and pg_ctl abort before they do anything.
const PG_TOOL_ENV = { ...process.env, LC_ALL: "C" };

function runSync(command: string, args: string[], label: string) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: PG_TOOL_ENV,
  });
  if (result.status !== 0) {
    fail(
      `${label} failed (${result.status}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

async function findFreeSafePort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const chosen = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(chosen));
      });
    });
    if (port > 1024 && !FORBIDDEN_PORTS.has(port)) return port;
  }
  return fail("Could not find a free port outside 5432/15432.");
}

interface HarnessState {
  port: number;
  dataDir: string;
  rootDir: string;
  databaseUrl: string;
}

function stateFile(rootDir: string) {
  return path.join(rootDir, "harness-state.json");
}

function readState(rootDir: string): HarnessState | null {
  const file = stateFile(rootDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as HarnessState;
  } catch {
    return null;
  }
}

function stopCluster(state: HarnessState, pgBinDir: string) {
  const stop = spawnSync(
    path.join(pgBinDir, "pg_ctl"),
    ["-D", state.dataDir, "-m", "immediate", "-w", "-t", "30", "stop"],
    { encoding: "utf8", env: PG_TOOL_ENV },
  );
  if (stop.status !== 0) {
    console.warn(
      `[decision-card-apply-harness] pg_ctl stop exited ${stop.status}: ${stop.stderr?.trim() ?? ""}`,
    );
  }
}

function runChild(
  scriptArgs: string[],
  databaseUrl: string,
  label: string,
  extraEnv: Record<string, string> = {},
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, scriptArgs, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        // Pre-set so `@next/env`'s loadEnvConfig can never substitute the
        // production tunnel from .env.local.
        DATABASE_URL: databaseUrl,
        DATABASE_URL_UNPOOLED: databaseUrl,
        PGHOST: "127.0.0.1",
        PGDATABASE: DB_NAME,
        PGUSER: DB_USER,
        ENABLE_RUNTIME_MIGRATIONS: "1",
        ...extraEnv,
      },
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}.`));
    });
  });
}

/* ------------------------------------------------------------------ seeding */

/*
 * Everything below runs in-process AFTER `process.env.DATABASE_URL` has been
 * pointed at the throwaway cluster, and reaches the database only through
 * dynamically imported production modules. A static import would be hoisted
 * above the assignment and `lib/db` would memoise the wrong URL.
 */

type Sql = { query: (text: string, params?: unknown[]) => Promise<unknown> };

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

async function seed(asOf: string) {
  const { getDb } = await import("@/lib/db");
  const { hashPassword } = await import("@/lib/auth");
  const { CAMPAIGN_CONTEXT_RESOLVER_VERSION } = await import(
    "@/lib/creative-decision-engine/campaign-context/resolver"
  );
  const { BID_SIZING_POLICY_VERSION } = await import("@/lib/meta/bid-sizing-policy");
  const { BUDGET_SIZING_POLICY_VERSION } = await import(
    "@/lib/meta/budget-sizing-policy"
  );
  const { runMetaSnapshotForBusiness } = await import("@/lib/meta/snapshot");
  const sql = getDb() as unknown as Sql;

  /*
   * The resolver identity this deployment approves, taken from the constant
   * rather than typed out. `isCampaignContextResolverAuthorityValidated`
   * compares it byte-for-byte, and without the approval every campaign role is
   * withheld — which withdraws the authority the sizing policies need. The
   * launcher exports the same value so the RUNNING app agrees with the seed.
   */
  process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION =
    CAMPAIGN_CONTEXT_RESOLVER_VERSION;

  // ---------------------------------------------------------------- identity
  const passwordHash = await hashPassword(OPERATOR_PASSWORD);
  await sql.query(
    `INSERT INTO users (id, email, name, password_hash)
     VALUES ($1::uuid, $2, 'Harness operator', $3)
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [OPERATOR, OPERATOR_EMAIL, passwordHash],
  );
  /*
   * A second, read-only identity for the reviewer negative case.
   *
   * The shipped `isReviewerEmail` reviewer is a single hard-coded address that
   * `canReviewerAccessBusiness` confines to the demo business, so it cannot be
   * pointed at this workspace. The other half of the same predicate —
   * `readOnly = reviewer || role === "guest"` in `workspaceViewer` — is
   * reachable, and it is the one that governs what the surface renders. This
   * member is a genuinely different session rather than the operator with a
   * mutated role, so the positive and negative cases cannot be the same login.
   */
  await sql.query(
    `INSERT INTO users (id, email, name, password_hash)
     VALUES ($1::uuid, $2, 'Harness reviewer', $3)
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [REVIEWER, REVIEWER_EMAIL, passwordHash],
  );
  /*
   * `is_demo_business` FALSE, explicitly. `readMetaBusinessDataPosture`
   * answers `unverified` for anything it cannot prove is a real workspace, and
   * `/api/meta/decisions-workspace` then returns 503 before it reads anything.
   */
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, timezone, currency, is_demo_business)
     VALUES ($1::uuid, 'Decision card apply harness', $2::uuid, 'UTC', 'USD', FALSE)
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS, OPERATOR],
  );
  await sql.query(
    `INSERT INTO memberships (user_id, business_id, role, status)
     VALUES ($1::uuid, $2::uuid, 'admin', 'active')
     ON CONFLICT DO NOTHING`,
    [OPERATOR, BUSINESS],
  );
  await sql.query(
    `INSERT INTO memberships (user_id, business_id, role, status)
     VALUES ($1::uuid, $2::uuid, 'guest', 'active')
     ON CONFLICT DO NOTHING`,
    [REVIEWER, BUSINESS],
  );

  const accountRows = (await sql.query(
    `INSERT INTO provider_accounts
       (provider, external_account_id, account_name, currency, timezone)
     VALUES ('meta', $1, 'Harness ad account', 'USD', 'UTC')
     ON CONFLICT (provider, external_account_id)
     DO UPDATE SET currency = EXCLUDED.currency
     RETURNING id::text AS id`,
    [ACCOUNT],
  )) as Array<{ id: string }>;
  const accountRefId = accountRows[0]!.id;
  // `is_selected` is what `readAssignmentRowsByBusiness` filters on. An
  // unselected assignment reads as no assigned account at all, and the
  // campaign source returns `no_accounts_assigned` before the warehouse.
  await sql.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id,
        position, is_selected)
     VALUES ($1, 'meta', $2::uuid, $3, 0, TRUE)
     ON CONFLICT (business_id, provider, provider_account_ref_id)
     DO UPDATE SET is_selected = TRUE`,
    [BUSINESS, accountRefId, ACCOUNT],
  );

  /*
   * A connected Meta integration with a stub credential.
   *
   * Unlike the read-only economics seam, this fixture has to reach the write
   * boundary: `prepareEntityAction` builds a provider context from this row,
   * and without it the pause route refuses before the ceremony can produce a
   * receipt. The token never leaves the machine — the browser recipe installs
   * an undici MockAgent with `disableNetConnect()`, so the only thing that can
   * answer graph.facebook.com is the double.
   */
  const metaConnection = (await sql.query(
    `INSERT INTO provider_connections
       (business_id, provider, status, provider_account_id, provider_account_name,
        connected_at)
     VALUES ($1, 'meta', 'connected', $2, 'Harness ad account', now())
     ON CONFLICT DO NOTHING
     RETURNING id::text AS id`,
    [BUSINESS, ACCOUNT],
  )) as Array<{ id: string }>;
  if (metaConnection[0]?.id) {
    await sql.query(
      `INSERT INTO integration_credentials
         (provider_connection_id, access_token, metadata)
       VALUES ($1::uuid, 'harness-meta-token', $2::jsonb)`,
      [metaConnection[0].id, JSON.stringify({ iana_timezone: "UTC" })],
    );
  }

  // ------------------------------------------------------- commercial truth
  /*
   * ROAS only. Target CPA, break-even CPA and the AOV assumption are all null
   * on purpose: ROAS is the single required commercial target, and an operator
   * is never asked for a CPA or an AOV. The store below is therefore the only
   * source of a CPA benchmark, which is what makes the decision's economics
   * real rather than configured.
   */
  await sql.query(
    `INSERT INTO business_target_pack_history
       (business_id, target_roas, break_even_roas, target_cpa, break_even_cpa,
        aov_assumption, default_risk_posture, operation, effective_at, recorded_at)
     VALUES ($1::uuid, 2.20, 1.80, NULL, NULL, NULL, 'balanced', 'upsert',
             $2::timestamptz, $2::timestamptz)`,
    [BUSINESS, `${addDays(asOf, -WINDOW_DAYS)}T00:00:00.000Z`],
  );

  await seedShopifyStore(sql, asOf);

  /*
   * The account's automation posture: STOP released, live writes allowed.
   *
   * `dryRunOnly` is deliberately FALSE. A rehearsal completes the whole
   * ceremony and posts nothing, which would leave the mounted proof exactly
   * where it started — a receipt no provider ever saw. The provider double is
   * what makes that safe.
   *
   * The ceiling states USD explicitly. An ABSENT ceiling takes the packaged
   * EUR default and every sized intent then dies on
   * `policy_spend_ceiling_currency_mismatch` against a USD account — a refusal
   * that reads as a policy decision and is really a fixture omission. Both
   * policy versions must equal the constants the policies check, or they
   * refuse on the version alone before any evidence is read.
   */
  await sql.query(
    `INSERT INTO meta_automation_business_controls
       (business_id, kill_switch_engaged, auto_execution_enabled, readiness_tier,
        guardrails_json)
     VALUES ($1::uuid, FALSE, FALSE, 'manual_review', $2::jsonb)
     ON CONFLICT (business_id) DO UPDATE SET guardrails_json = EXCLUDED.guardrails_json,
       kill_switch_engaged = FALSE`,
    [
      BUSINESS,
      JSON.stringify({
        dryRunOnly: false,
        maxBudgetIncreasePct: 15,
        perActionSpendCeilingMinor: 40000,
        perActionSpendCeilingCurrency: "USD",
        budgetMinHoursBetweenChanges: 24,
        budgetMaxChangesPer7d: 3,
        budgetMaxAccountConcentrationPct: 60,
        budgetSizingPolicyVersion: BUDGET_SIZING_POLICY_VERSION,
        bidSizingPolicyVersion: BID_SIZING_POLICY_VERSION,
      }),
    ],
  );
  // An absent mode row reads `manual`, and both producers return early on that
  // before they ever look at a candidate.
  for (const decisionType of ["budget", "bid"]) {
    await sql.query(
      `INSERT INTO meta_automation_decision_type_modes (business_id, decision_type, mode)
       VALUES ($1::uuid, $2, 'semi_auto')
       ON CONFLICT (business_id, decision_type) DO UPDATE SET mode = 'semi_auto'`,
      [BUSINESS, decisionType],
    );
  }

  // ----------------------------------------------------------- the facts
  await seedWarehouseFacts(asOf);
  await publishSlices(asOf);

  await seedBudgetState({ asOf, accountRefId });

  /*
   * Only the capped campaign gets a published role.
   *
   * `contextTrust` is `high` only on an exact `high` confidence class, a
   * byte-for-byte `system_inferred` origin AND an approved resolver identity;
   * anything less leaves the label map empty and `roleAuthoritySatisfied`
   * false for every campaign. The second campaign is deliberately left without
   * one, so the fixture also carries a role-unauthorised contrast case.
   */
  await sql.query(
    `INSERT INTO engine_v3_campaign_context_daily
       (business_id, provider_account_id, campaign_id, campaign_name, as_of_date,
        inferred_kind, confidence_score, confidence_class, kind_source,
        kind_basis, resolver_version)
     VALUES ($1, $2, $3, 'Prospecting CBO', $4::date, 'main', 0.95, 'high',
             'system_inferred', 'system_inference', $5)
     ON CONFLICT DO NOTHING`,
    [BUSINESS, ACCOUNT, CAPPED_CAMPAIGN, asOf, CAMPAIGN_CONTEXT_RESOLVER_VERSION],
  );

  // --------------------------------------------- the decision, really produced
  const run = await runMetaSnapshotForBusiness(BUSINESS, asOf);
  return { accountRefId, run };
}

async function seedShopifyStore(sql: Sql, asOf: string) {
  const shop = "decision-card-apply-harness.myshopify.test";
  const connection = (await sql.query(
    `INSERT INTO provider_connections
       (business_id, provider, status, provider_account_id, provider_account_name,
        connected_at)
     VALUES ($1, 'shopify', 'connected', $2, 'Harness store', now())
     RETURNING id::text AS id`,
    [BUSINESS, shop],
  )) as Array<{ id: string }>;
  await sql.query(
    `INSERT INTO integration_credentials
       (provider_connection_id, access_token, metadata)
     VALUES ($1::uuid, 'harness-shopify-token', $2::jsonb)`,
    [connection[0]!.id, JSON.stringify({ iana_timezone: "UTC" })],
  );
  /*
   * Freshness and coverage are two different facts and the reader checks both.
   *
   * `latest_successful_sync_at` is our clock. Coverage is proved from the
   * recorded window alone, and `recentOrderSpanIsProven` will only pair
   * `latest_sync_window_start` with `ready_through_date` when the LAST
   * recorded attempt succeeded and its own `latest_sync_window_end` equals
   * that retained success end — the pair a single successful recent pass
   * writes in one upsert. A fixture that omits `latest_sync_window_end`, or
   * names a target the reader does not read (only `commerce_orders_recent` and
   * `commerce_orders_historical` count), yields `orders_coverage_unproven` and
   * the whole economics chain then withholds for want of a CPA benchmark.
   */
  await sql.query(
    `INSERT INTO shopify_sync_state
       (business_id, provider_account_id, sync_target,
        latest_successful_sync_at, latest_sync_window_start,
        latest_sync_window_end, ready_through_date, latest_sync_status)
     VALUES ($1, $2, 'commerce_orders_recent', now(),
             $3::date, $4::date, $4::date, 'succeeded')
     ON CONFLICT (business_id, provider_account_id, sync_target)
     DO UPDATE SET latest_successful_sync_at = EXCLUDED.latest_successful_sync_at`,
    [BUSINESS, shop, addDays(asOf, -120), asOf],
  );
  for (let index = 0; index < 60; index += 1) {
    const day = addDays(asOf, -(1 + (index % 27)));
    await sql.query(
      `INSERT INTO shopify_orders
         (business_id, provider_account_id, shop_id, order_id, currency_code,
          shop_currency_code, order_created_at, order_created_date_local,
          total_price, current_total_price, original_total_price)
       VALUES ($1, $2, $2, $3, 'USD', 'USD', $4::timestamptz, $5::date, 58.00, 58.00, 58.00)
       ON CONFLICT DO NOTHING`,
      [BUSINESS, shop, `harness-order-${index}`, `${day}T12:00:00.000Z`, day],
    );
    await sql.query(
      `INSERT INTO shopify_sales_events
         (business_id, provider_account_id, shop_id, event_id, source_kind,
          source_id, order_id, occurred_at, occurred_date_local,
          gross_sales, net_revenue, currency_code)
       VALUES ($1, $2, $2, $3, 'order', $4, $4, $5::timestamptz, $6::date,
               58.00, 58.00, 'USD')
       ON CONFLICT DO NOTHING`,
      [
        BUSINESS,
        shop,
        `harness-event-${index}`,
        `harness-order-${index}`,
        `${day}T12:00:00.000Z`,
        day,
      ],
    );
  }
}

async function seedWarehouseFacts(asOf: string) {
  const {
    upsertMetaAccountDailyRows,
    upsertMetaAdSetDailyRows,
    upsertMetaCampaignDailyRows,
  } = await import("@/lib/meta/warehouse");
  const base = {
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    accountTimezone: "UTC",
    accountCurrency: "USD",
    sourceSnapshotId: null,
  };

  /*
   * One day per call, the way the sync itself writes.
   *
   * `upsertMetaCampaignDailyRows` maintains the dimension tables as a side
   * effect and emits one dimension row per DAILY row, so a single call
   * carrying twenty-eight days of one campaign proposes twenty-eight rows with
   * the same conflict key and Postgres refuses the whole statement.
   */
  for (let back = WINDOW_DAYS - 1; back >= 0; back -= 1) {
    const date = addDays(asOf, -back);
    const isLatest = back === 0;
    const capped = metricRow({
      spend: 100,
      revenue: 360,
      conversions: 4,
      impressions: 4000,
      clicks: 30,
      reach: 1000,
    });
    const second = metricRow({
      spend: 50,
      revenue: 50,
      conversions: 1,
      impressions: 4000,
      clicks: 80,
      reach: 2700,
    });
    /*
     * The stall day: 500 impressions against a seven-day median of 4000 is an
     * 87.5% fall, which is what makes `delivery_stall` fire at high severity.
     * That anomaly is the ONLY evidence in this product that a cap is holding
     * delivery back, and the bid policy withholds every raise without it — so
     * the collapse is the fact that authorises the change, not decoration.
     */
    const cappedAdset = isLatest
      ? metricRow({
          spend: 40,
          revenue: 120,
          conversions: 19,
          impressions: 500,
          clicks: 3,
          reach: 200,
        })
      : metricRow({
          spend: 80,
          revenue: 240,
          conversions: 3,
          impressions: 4000,
          clicks: 30,
          reach: 1000,
        });
    await upsertMetaAccountDailyRows([
      {
        ...base,
        date,
        accountName: "Harness ad account",
        ...metricRow({
          spend: capped.spend + second.spend,
          revenue: capped.revenue + second.revenue,
          conversions: capped.conversions + second.conversions,
          impressions: capped.impressions + second.impressions,
          clicks: capped.clicks + second.clicks,
          reach: capped.reach + second.reach,
        }),
      },
    ]);
    await upsertMetaCampaignDailyRows([
      {
        ...base,
        date,
        campaignId: CAPPED_CAMPAIGN,
        campaignNameCurrent: "Prospecting CBO",
        campaignNameHistorical: "Prospecting CBO",
        campaignStatus: "ACTIVE",
        objective: "OUTCOME_SALES",
        buyingType: "AUCTION",
        optimizationGoal: "OFFSITE_CONVERSIONS",
        customEventType: "PURCHASE",
        bidStrategyType: "lowest_cost",
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: 250,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isCustomEventTypeMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        ...capped,
      },
      {
        ...base,
        date,
        campaignId: SECOND_CAMPAIGN,
        campaignNameCurrent: "Retargeting ABO",
        campaignNameHistorical: "Retargeting ABO",
        campaignStatus: "ACTIVE",
        objective: "OUTCOME_SALES",
        buyingType: "AUCTION",
        optimizationGoal: "OFFSITE_CONVERSIONS",
        customEventType: "PURCHASE",
        bidStrategyType: "lowest_cost",
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isCustomEventTypeMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        ...second,
      },
    ]);
    await upsertMetaAdSetDailyRows([
      {
        ...base,
        date,
        campaignId: CAPPED_CAMPAIGN,
        adsetId: CAPPED_ADSET,
        adsetNameCurrent: "Broad prospecting",
        adsetNameHistorical: "Broad prospecting",
        adsetStatus: "ACTIVE",
        optimizationGoal: "OFFSITE_CONVERSIONS",
        customEventType: "PURCHASE",
        // A $12.00 cost cap: the writable number the whole apply path is about.
        bidStrategyType: "cost_cap",
        bidStrategyLabel: "Cost cap",
        manualBidAmount: null,
        bidValue: 12.0,
        bidValueFormat: "currency",
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        ...cappedAdset,
      },
      {
        ...base,
        date,
        campaignId: SECOND_CAMPAIGN,
        adsetId: SECOND_ADSET,
        adsetNameCurrent: "Retargeting 30d",
        adsetNameHistorical: "Retargeting 30d",
        adsetStatus: "ACTIVE",
        optimizationGoal: "OFFSITE_CONVERSIONS",
        customEventType: "PURCHASE",
        bidStrategyType: "lowest_cost",
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: 250,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        ...second,
      },
    ]);
  }
}

/**
 * The retained budget truth, with the foreign-key chain it depends on.
 *
 * `meta_entity_state_history` rows carry a COMPOSITE key back to an observation
 * run — id, business, account, entity type, captured_at and completeness all
 * have to agree — so the run has to exist first. The capped ad set carries its
 * parent's amount and owns none of it, which is what makes its budget universe
 * `proven_non_applicable` and keeps a budget intent off it; an ad set that
 * acquired one would suppress its own bid intent as a sibling change in the
 * same window.
 */
async function seedBudgetState(input: { asOf: string; accountRefId: string }) {
  const { getDb } = await import("@/lib/db");
  const sql = getDb() as unknown as Sql;
  const captured = `${input.asOf}T03:00:00.000Z`;
  const runFor = async (entityType: "campaign" | "adset") => {
    const rows = (await sql.query(
      `INSERT INTO meta_entity_observation_runs
         (business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, endpoint,
          observed_at, captured_at, completeness, run_hash)
       VALUES ($1::uuid, $2, $6::uuid, $3, $4, '/act/' || $3,
               $5::timestamptz, $5::timestamptz, 'complete', $7)
       RETURNING id::text AS id`,
      [
        BUSINESS,
        BUSINESS,
        ACCOUNT,
        entityType,
        captured,
        input.accountRefId,
        (entityType === "campaign" ? "a" : "b").repeat(64),
      ],
    )) as Array<{ id: string }>;
    return rows[0]!.id;
  };
  const runIds = {
    campaign: await runFor("campaign"),
    adset: await runFor("adset"),
  };

  let stateHashSeed = 0;
  const state = async (entry: {
    entityType: "campaign" | "adset";
    entityId: string;
    campaignId: string;
    origin: string;
    campaignDaily: string | null;
    adsetDaily: string | null;
  }) => {
    stateHashSeed += 1;
    await sql.query(
      `INSERT INTO meta_entity_state_history
         (run_id, business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, entity_id, campaign_id, adset_id,
          configured_status, effective_status,
          campaign_daily_budget_raw, adset_daily_budget_raw,
          budget_currency, budget_currency_exponent, budget_origin,
          presence, observed_at, captured_at, run_completeness, state_hash)
       VALUES ($1::uuid, $2::uuid, $3, $14::uuid, $4, $5, $6, $7, $8,
               'ACTIVE', 'ACTIVE', $9, $10, 'USD', 2, $11, 'present',
               $12::timestamptz, $12::timestamptz, 'complete', $13)`,
      [
        runIds[entry.entityType],
        BUSINESS,
        BUSINESS,
        ACCOUNT,
        entry.entityType,
        entry.entityId,
        entry.campaignId,
        entry.entityType === "adset" ? entry.entityId : null,
        entry.campaignDaily,
        entry.adsetDaily,
        entry.origin,
        captured,
        String(stateHashSeed).padStart(64, "0"),
        input.accountRefId,
      ],
    );
  };

  await state({
    entityType: "campaign",
    entityId: CAPPED_CAMPAIGN,
    campaignId: CAPPED_CAMPAIGN,
    origin: "campaign",
    campaignDaily: "25000",
    adsetDaily: null,
  });
  await state({
    entityType: "adset",
    entityId: CAPPED_ADSET,
    campaignId: CAPPED_CAMPAIGN,
    origin: "campaign",
    campaignDaily: "25000",
    adsetDaily: null,
  });
  await state({
    entityType: "adset",
    entityId: SECOND_ADSET,
    campaignId: SECOND_CAMPAIGN,
    origin: "adset",
    campaignDaily: null,
    adsetDaily: "25000",
  });
  // No `meta_budget_write_journal` rows: this fixture has never changed these
  // budgets, which is a real observation rather than an unreadable one.
}

/**
 * Publication, through the real slice lifecycle.
 *
 * `filterRowsToPublishedKeys` drops every warehouse row whose `account:day` is
 * not a published key, and an empty key set returns an empty array — so an
 * unpublished fixture reads as an account with no campaigns, no ad sets and no
 * census. The gate is satisfied by publishing real slices, never by switching
 * `META_AUTHORITATIVE_FINALIZATION_V2` off: that flag defaults ON in
 * production, and a fixture that turns it off proves the surface against a
 * configuration nobody runs.
 *
 * `account_daily` is published as well as the two structure surfaces. The
 * account-pulse upstream reads it, and `/api/meta/decisions-workspace` awaits
 * both upstreams before it serves anything at all.
 */
async function publishSlices(asOf: string) {
  const {
    createMetaAuthoritativeSliceVersion,
    publishMetaAuthoritativeSliceVersion,
  } = await import("@/lib/meta/warehouse");
  for (let back = WINDOW_DAYS - 1; back >= 0; back -= 1) {
    const day = addDays(asOf, -back);
    for (const surface of [
      "account_daily",
      "campaign_daily",
      "adset_daily",
    ] as const) {
      const slice = await createMetaAuthoritativeSliceVersion({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        day,
        surface,
        state: "pending_finalization",
        truthState: "finalized",
        validationStatus: "passed",
        status: "validated",
      });
      if (!slice?.id) fail(`slice_not_created ${day} ${surface}`);
      await publishMetaAuthoritativeSliceVersion({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        day,
        surface,
        sliceVersionId: slice.id,
        publicationReason: "decision_card_apply_harness",
      });
    }
  }
}

/* --------------------------------------------------------------------- main */

async function main() {
  const args = new Set(process.argv.slice(2));
  const rootDir =
    process.env.DECISION_CARD_APPLY_HARNESS_ROOT?.trim() ||
    path.join(os.tmpdir(), "adsecute-decision-card-apply-harness");
  const pgBinDir = resolvePgBinDir();

  if (args.has("--stop")) {
    const state = readState(rootDir);
    if (!state) {
      log(`nothing to stop under ${rootDir}`);
      return;
    }
    stopCluster(state, pgBinDir);
    fs.rmSync(rootDir, { recursive: true, force: true });
    log(`stopped and removed ${rootDir}`);
    return;
  }

  const existing = readState(rootDir);
  if (existing) {
    fail(
      `A harness cluster is already recorded at ${rootDir} (port ${existing.port}). ` +
        "Run with --stop first, or set DECISION_CARD_APPLY_HARNESS_ROOT to a different directory.",
    );
  }

  const port = await findFreeSafePort();
  if (FORBIDDEN_PORTS.has(port)) fail(`refusing port ${port}`);
  const dataDir = path.join(rootDir, "pgdata");
  const logFile = path.join(rootDir, "postgres.log");
  const databaseUrl = `postgresql://${DB_USER}@127.0.0.1:${port}/${DB_NAME}`;
  fs.mkdirSync(rootDir, { recursive: true });

  log(`pg binaries: ${pgBinDir}`);
  log(`port:        ${port} (never 5432 / 15432)`);
  log("initdb: creating a fresh cluster...");
  runSync(
    path.join(pgBinDir, "initdb"),
    [
      "-D",
      dataDir,
      "-U",
      DB_USER,
      "--auth=trust",
      "--encoding=UTF8",
      "--no-locale",
    ],
    "initdb",
  );
  log("pg_ctl: starting...");
  runSync(
    path.join(pgBinDir, "pg_ctl"),
    [
      "-D",
      dataDir,
      "-l",
      logFile,
      "-w",
      "-t",
      "60",
      "-o",
      // Loopback TCP only; unix sockets are off because a temp path can exceed
      // macOS's socket path limit. fsync off: the data is disposable.
      `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off`,
      "start",
    ],
    "pg_ctl start",
  );
  const state: HarnessState = { port, dataDir, rootDir, databaseUrl };
  fs.writeFileSync(stateFile(rootDir), JSON.stringify(state, null, 2));

  runSync(
    path.join(pgBinDir, "createdb"),
    ["-h", "127.0.0.1", "-p", String(port), "-U", DB_USER, DB_NAME],
    "createdb",
  );

  log("migrations: running the real deploy entry point...");
  await runChild(
    ["--import", "tsx", path.join("scripts", "run-migrations.ts")],
    databaseUrl,
    "run-migrations",
  );

  log("seeding...");
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_URL_UNPOOLED = databaseUrl;
  const asOf = resolveAsOf();
  const { run } = await seed(asOf);
  log(`snapshot run: ${JSON.stringify(run)}`);

  const appPort = await findFreeSafePort();
  writeProviderDouble(rootDir);
  const { CAMPAIGN_CONTEXT_RESOLVER_VERSION } = await import(
    "@/lib/creative-decision-engine/campaign-context/resolver"
  );
  writeLauncher({
    rootDir,
    databaseUrl,
    appPort,
    campaignContextResolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  });

  const summary = await describeFixture(asOf);
  console.log("");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(" Decision Center card-apply fixture is up.");
  console.log("");
  console.log(` DATABASE_URL   ${databaseUrl}`);
  console.log(` data dir       ${dataDir}`);
  console.log(` stop with      node --import tsx scripts/meta-decision-card-apply-harness.ts --stop`);
  console.log("");
  console.log(` sign in as     ${OPERATOR_EMAIL} / ${OPERATOR_PASSWORD}   (admin)`);
  console.log(` read-only      ${REVIEWER_EMAIL} / ${OPERATOR_PASSWORD}   (guest role)`);
  console.log("");
  console.log(` business       ${BUSINESS}`);
  console.log(` ad account     ${ACCOUNT}`);
  console.log(` as-of day      ${asOf}`);
  console.log(` capped ad set  ${CAPPED_ADSET} (the one carrying the sized bid intent)`);
  console.log("");
  console.log(` published keys ${summary.publishedKeys}`);
  console.log(` census rows    ${summary.censusRows}`);
  console.log(` recommendations ${summary.recommendations}`);
  console.log("");
  console.log(" start the app  sh " + path.join(rootDir, "start-dev.sh"));
  console.log(
    ` then open      http://127.0.0.1:${appPort}/c/${BUSINESS}/meta/decisions?providerAccountId=${ACCOUNT}`,
  );
  console.log(` provider log   ${path.join(rootDir, "provider-double.log")}`);
  console.log("──────────────────────────────────────────────────────────────");
}

/**
 * The Meta double, as a Node `--import` preload.
 *
 * It is an undici `MockAgent` with `disableNetConnect()`, so the running
 * application physically cannot reach Meta — an un-intercepted request throws
 * rather than escaping. Loopback is re-enabled because the app talks to its own
 * upstream routes over HTTP.
 *
 * It holds STATE. `updateEntityStatus` posts the status and then re-reads the
 * entity, and refuses on `silent_failure` when the read-back disagrees with
 * what it asked for. A double that always answered PAUSED would make that
 * check unfalsifiable, so this one answers with whatever it was last told —
 * which is what makes the read-back in the receipt worth anything.
 */
function writeProviderDouble(rootDir: string) {
  const file = path.join(rootDir, "meta-provider-double.mjs");
  fs.writeFileSync(
    file,
    `import fs from "node:fs";
/*
 * undici by absolute path: this file lives in a temp directory, so a bare
 * specifier resolves against that directory and finds nothing.
 *
 * The package's \`setGlobalDispatcher\` writes the well-known
 * \`Symbol.for("undici.globalDispatcher.1")\` on globalThis, which is the same
 * symbol Node's built-in \`fetch\` reads — so an external undici does redirect
 * the runtime's own fetch.
 */
import { MockAgent, setGlobalDispatcher } from ${JSON.stringify(
      path.join(process.cwd(), "node_modules", "undici", "index.js"),
    )};

const LOG = ${JSON.stringify(path.join(rootDir, "provider-double.log"))};
const ACCOUNT_ID = ${JSON.stringify(ACCOUNT.replace(/^act_/, ""))};

/*
 * The hierarchy the double is willing to confirm.
 *
 * \`readMetaEntityExecutionState\` asks an ad set for \`campaign{id}\` and the
 * manual preflight refuses with \`current_hierarchy_identity_mismatch\` when the
 * parent it gets back is not the parent the warehouse recorded. A double that
 * answered a bare id would fail every write for a reason that says nothing
 * about the product.
 */
const PARENTS = {
  ${JSON.stringify(CAPPED_ADSET)}: ${JSON.stringify(CAPPED_CAMPAIGN)},
  ${JSON.stringify(SECOND_ADSET)}: ${JSON.stringify(SECOND_CAMPAIGN)},
};

/** What the double currently believes about each entity. Writes move it. */
const entities = new Map(Object.entries({
  ${JSON.stringify(CAPPED_CAMPAIGN)}: { name: "Prospecting CBO", status: "ACTIVE" },
  ${JSON.stringify(SECOND_CAMPAIGN)}: { name: "Retargeting ABO", status: "ACTIVE" },
  ${JSON.stringify(CAPPED_ADSET)}: {
    name: "Broad prospecting",
    status: "ACTIVE",
    bid_amount: 1200,
    bid_strategy: "COST_CAP",
  },
  ${JSON.stringify(SECOND_ADSET)}: { name: "Retargeting 30d", status: "ACTIVE" },
}));

function record(entry) {
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\\n");
}

function node(id) {
  const state = entities.get(id) ?? { name: "Harness entity " + id, status: "ACTIVE" };
  const payload = {
    id,
    account_id: ACCOUNT_ID,
    name: state.name,
    status: state.status,
    effective_status: state.status,
    updated_time: new Date().toISOString(),
  };
  if (PARENTS[id]) payload.campaign = { id: PARENTS[id] };
  if (state.bid_amount !== undefined) payload.bid_amount = state.bid_amount;
  if (state.bid_strategy !== undefined) payload.bid_strategy = state.bid_strategy;
  return payload;
}

const agent = new MockAgent();
agent.disableNetConnect();
// The app calls its own upstream routes over loopback HTTP; only Meta is doubled.
agent.enableNetConnect((host) => host.startsWith("127.0.0.1") || host.startsWith("localhost"));
setGlobalDispatcher(agent);

const graph = agent.get("https://graph.facebook.com");

graph
  .intercept({ path: () => true, method: "POST" })
  .reply((options) => {
    const nodeId = options.path.split("?")[0].split("/").filter(Boolean).pop();
    const body = new URLSearchParams(String(options.body ?? ""));
    const state = entities.get(nodeId) ?? { name: "Harness entity " + nodeId, status: "ACTIVE" };
    if (body.get("status")) state.status = body.get("status");
    if (body.get("bid_amount")) state.bid_amount = Number(body.get("bid_amount"));
    if (body.get("bid_strategy")) state.bid_strategy = body.get("bid_strategy");
    entities.set(nodeId, state);
    record({ method: "POST", path: options.path, body: Object.fromEntries(body) });
    return { statusCode: 200, data: { success: true, id: nodeId } };
  })
  .persist();

graph
  .intercept({ path: () => true, method: "GET" })
  .reply((options) => {
    const [pathname, search] = options.path.split("?");
    const query = new URLSearchParams(search ?? "");
    record({ method: "GET", path: options.path });
    /*
     * The batch form. \`GET /?ids=a,b,c\` answers with an object KEYED by id,
     * not with a node — and the lane's live-status probe uses it, so a double
     * that treated it as a single node would report every entity's current
     * status as unknown.
     */
    const ids = query.get("ids");
    if (ids) {
      const data = {};
      for (const id of ids.split(",").filter(Boolean)) data[id] = node(id);
      return { statusCode: 200, data };
    }
    const nodeId = pathname.split("/").filter(Boolean).pop() ?? "";
    if (nodeId.startsWith("act_")) {
      return {
        statusCode: 200,
        data: {
          id: nodeId,
          account_id: nodeId.replace(/^act_/, ""),
          name: "Harness ad account",
          currency: "USD",
          timezone_name: "UTC",
          account_status: 1,
        },
      };
    }
    if (nodeId.endsWith("/ads") || pathname.endsWith("/ads")) {
      return { statusCode: 200, data: { data: [] } };
    }
    return { statusCode: 200, data: node(nodeId) };
  })
  .persist();
`,
    "utf8",
  );
}

/**
 * The launcher.
 *
 * `DATABASE_URL` is exported BEFORE `next dev` starts, because `@next/env`
 * skips keys already present in `process.env` — which is the only thing
 * standing between this fixture and the production tunnel `.env.local` names.
 * The three UI/write gates are set here rather than in a checked-in env file so
 * that nothing about this fixture can leak into a normal `npm run dev`.
 */
function writeLauncher(input: {
  rootDir: string;
  databaseUrl: string;
  appPort: number;
  campaignContextResolverVersion: string;
}) {
  fs.writeFileSync(
    path.join(input.rootDir, "start-dev.sh"),
    `#!/bin/sh
set -e
cd ${JSON.stringify(process.cwd())}
export DATABASE_URL=${JSON.stringify(input.databaseUrl)}
export DATABASE_URL_UNPOOLED=${JSON.stringify(input.databaseUrl)}
export META_AUTOMATION_LIVE_WRITES=true
export META_DECISION_WORKFLOW_UI=true
export ZERO_BASE_MUTATION_UI_ENABLED=true
export ALLOW_INSECURE_LOCAL_AUTH_COOKIE=1
export CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION=${JSON.stringify(
      input.campaignContextResolverVersion,
    )}
export NODE_OPTIONS="--import ${path.join(input.rootDir, "meta-provider-double.mjs")}"
exec npx next dev --port ${input.appPort}
`,
    "utf8",
  );
}

/**
 * What the fixture actually produced, read back through the SAME production
 * readers the surface uses.
 *
 * Printing counts from the seed's own inserts would say nothing: the whole
 * point of this harness is the distance between what was written and what the
 * publication-gated readers will serve.
 */
async function describeFixture(asOf: string) {
  const { getMetaPublishedVerificationSummary } = await import(
    "@/lib/meta/warehouse"
  );
  const { getMetaCampaignsForRange } = await import("@/lib/meta/campaigns-source");
  const { readLatestMetaDecisionSnapshot } = await import("@/lib/meta/snapshot");
  const startDate = addDays(asOf, -(WINDOW_DAYS - 1));
  const verification = await getMetaPublishedVerificationSummary({
    businessId: BUSINESS,
    startDate,
    endDate: asOf,
    providerAccountIds: [ACCOUNT],
    surfaces: ["campaign_daily"],
  });
  const campaigns = await getMetaCampaignsForRange({
    businessId: BUSINESS,
    accountId: ACCOUNT,
    startDate,
    endDate: asOf,
  });
  const snapshot = await readLatestMetaDecisionSnapshot({
    businessId: BUSINESS,
    startDate,
    endDate: asOf,
  });
  return {
    publishedKeys: verification.publishedKeysBySurface.campaign_daily?.length ?? 0,
    censusRows: campaigns.rows.length,
    recommendations: snapshot?.recommendations.length ?? 0,
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
