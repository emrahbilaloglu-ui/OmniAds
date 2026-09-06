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
 * WHAT IT FOUND, AND WHAT HAS SINCE CHANGED
 *
 * Running it first showed that the card-level Apply could not be reached by any
 * recommendation this engine produces: `proposedActionForRecommendation`
 * granted an executable action only to an `adset`-grain recommendation whose
 * `type` was `bid_value_guidance`, and the only emitter of that type builds a
 * CAMPAIGN recommendation. The condition was unsatisfiable for every real row.
 *
 * That gate has since been repaired — the predicate reads the bid-intent
 * contract (`executableBidIntentMinorUnits`) instead of the label, and
 * `restampProposedActions` re-takes the stamp after the sizing pass. The
 * `--rerun-probe` mode below prints the served control per run, derived by the
 * surface's own `serverOperatorApplyForRec`, and it now reads
 * `{"action":"bid","grain":"adset","entityId":"9000000000201","bidAmountMinor":1320}`
 * on the capped ad set. The confirmation queue carries the same amount; the two
 * surfaces read one predicate and can no longer disagree.
 *
 * THE RERUN PROBE
 *
 * `--rerun-probe` settles a contradiction the QA guide used to carry. The guide
 * claimed a same-day rerun loses the bid evidence, and offered two DELETEs as
 * the workaround. It was wrong about THAT path: `delivery_stall` is a pure
 * function of the warehouse tables and reads nothing a previous run wrote, so
 * the bid evidence survives. The probe seeds the same fixture, drives
 * `runMetaSnapshotForBusiness` four times — twice on byte-identical facts, once
 * after the operator settles the queue row, once after the stall genuinely
 * recovers — and prints the numbers instead of a verdict.
 *
 * THE CLOCK RERUN PROBE
 *
 * `--clock-rerun-probe` grades the OTHER half, which the first probe cannot
 * see. Three of the seven anomaly families read the wall clock or the business
 * profile as well as the warehouse, and two of those decline to judge outside a
 * time-of-day window. A same-day rerun at a different hour therefore leaves
 * those families unevaluated — and the writer used to read "absent from this
 * run's payload" as "no longer true" and stamp `resolved_at` on an open row.
 * This mode seeds a business with a timezone and a campaign at 96/100 of its
 * daily budget, then drives the snapshot at four injected wall clocks and
 * prints each run's anomaly rows.
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
 *   node --import tsx scripts/meta-decision-card-apply-harness.ts --rerun-probe
 *   node --import tsx scripts/meta-decision-card-apply-harness.ts --clock-rerun-probe
 *
 * See docs/qa/decision-card-apply-harness.md for the full browser recipe.
 */
import { createHash } from "node:crypto";
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

async function seed(asOf: string, options: { runSnapshot?: boolean } = {}) {
  const runSnapshot = options.runSnapshot !== false;
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
  /*
   * BOTH halves of one save, because the product writes both in one statement.
   *
   * `upsertBusinessCommercialTruth` inserts `business_target_packs` and
   * appends `business_target_pack_history` in the same CTE, and the two are
   * read by DIFFERENT callers: the engine reads the HISTORY as-of the snapshot
   * day (`readMetaCommercialTargets(businessId, { asOf })`), while every
   * serve-time re-validation reads the CURRENT pack through
   * `getBusinessCommercialTruthSnapshot`.
   *
   * The first version of this fixture wrote only the history row, which is a
   * state the product's own writer cannot produce: a business with a target
   * history and no current pack. The engine then sized a decision against
   * ROAS 2.20 and the surface immediately withdrew it, because the current
   * read answered `source: "none"` and
   * `revalidateMetaStructureLanesForCurrentTargets` stamps
   * `current_commercial_target_authority_unavailable` on every hard action
   * when the current anchor is unavailable. The measured result was two scale
   * decisions degraded to "Review Commercial Truth" — a finding about the
   * FIXTURE, not about the engine. Writing both halves is what makes the
   * matrix measure the product.
   */
  const targetPackEffectiveAt = `${addDays(asOf, -WINDOW_DAYS)}T00:00:00.000Z`;
  await sql.query(
    `INSERT INTO business_target_pack_history
       (business_id, target_roas, break_even_roas, target_cpa, break_even_cpa,
        aov_assumption, default_risk_posture, operation, effective_at, recorded_at)
     VALUES ($1::uuid, 2.20, 1.80, NULL, NULL, NULL, 'balanced', 'upsert',
             $2::timestamptz, $2::timestamptz)`,
    [BUSINESS, targetPackEffectiveAt],
  );
  await sql.query(
    `INSERT INTO business_target_packs
       (business_id, business_ref_id, target_roas, break_even_roas, target_cpa,
        break_even_cpa, aov_assumption, default_risk_posture, source_label,
        updated_by_user_id, updated_at)
     VALUES ($1::uuid, $1::uuid, 2.20, 1.80, NULL, NULL, NULL, 'balanced',
             'decision availability harness', $2::uuid, $3::timestamptz)
     ON CONFLICT (business_id) DO UPDATE SET
       target_roas = EXCLUDED.target_roas,
       break_even_roas = EXCLUDED.break_even_roas,
       target_cpa = EXCLUDED.target_cpa,
       break_even_cpa = EXCLUDED.break_even_cpa,
       aov_assumption = EXCLUDED.aov_assumption,
       updated_at = EXCLUDED.updated_at`,
    [BUSINESS, OPERATOR, targetPackEffectiveAt],
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
  /*
   * The rerun probe seeds the same facts and then drives the snapshot itself,
   * so it asks for the seed WITHOUT this first run. Everything above is
   * identical either way: the probe grades the production function, not a
   * second fixture.
   */
  const run = runSnapshot ? await runMetaSnapshotForBusiness(BUSINESS, asOf) : null;
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
   * SUCCESS-ONLY bounds — `latest_successful_sync_window_start` and
   * `latest_successful_sync_window_end` — which `resolveRetainedRecentOrderSpan`
   * reads and which only a finished pass writes. The attempt columns
   * (`latest_sync_window_start` / `_end`) are written by running and failed
   * attempts too, so they are recorded here as well and deliberately kept
   * EQUAL to the success bounds: a fixture whose attempt window reaches
   * outside its own proven span is `orders_coverage_unproven` by design, which
   * is the webhook-repair case, not this one.
   *
   * Omit the success pair, or name a target the reader does not read (only
   * `commerce_orders_recent` and `commerce_orders_historical` count), and the
   * answer is `orders_coverage_unproven`: no CPA benchmark, no spend unit, and
   * the whole economics chain withholds — which is exactly what this fixture
   * silently started doing when the success-only columns landed.
   */
  await sql.query(
    `INSERT INTO shopify_sync_state
       (business_id, provider_account_id, sync_target,
        latest_successful_sync_at, latest_sync_window_start,
        latest_sync_window_end, ready_through_date, latest_sync_status,
        latest_successful_sync_window_start, latest_successful_sync_window_end)
     VALUES ($1, $2, 'commerce_orders_recent', now(),
             $3::date, $4::date, $4::date, 'succeeded',
             $3::date, $4::date)
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


/* -------------------------------------------------------------- rerun probe */

/**
 * The stability probe.
 *
 * Codex flagged a contradiction rather than a diagnosis: the guide claimed a
 * same-day rerun loses bid evidence, while `delivery_stall` — the family the
 * bid path depends on — is a pure function of warehouse rows and reads no
 * previously written anomaly. Only driving it twice on byte-identical facts
 * settles which side is true, so this mode does exactly that and prints the
 * numbers rather than a verdict.
 *
 * It grades ONE family's stability, not the detector's. `pacing_failure`,
 * `budget_exhausted_early` and `zero_conversions_with_spend` additionally read
 * the wall clock and the business profile; `--clock-rerun-probe` is where those
 * are driven, because this fixture's snapshot date is always yesterday and two
 * of them are permanently outside their gate on a closed day.
 *
 * It never trusts the caller's own `.catch(() => [])`: the detector is called
 * DIRECTLY, unguarded, immediately before each snapshot, so a swallowed throw
 * shows up as a stack instead of as a zero.
 */
type ProbeSql = { query: (text: string, params?: unknown[]) => Promise<unknown> };

/**
 * A checksum over exactly the columns `fetchAnomalyInputs` selects.
 *
 * "Unchanged facts" has to be a measurement, not an assumption: if run 1 wrote
 * anything back into the warehouse the second run reads, this number moves and
 * the whole question is answered before the detector is even called.
 */
async function warehouseFactFingerprint(sql: ProbeSql, asOf: string) {
  const rows = (await sql.query(
    `SELECT
       (SELECT COALESCE(md5(string_agg(t, '|' ORDER BY t)), '-') FROM (
          SELECT campaign_id || ':' || date::text || ':' || COALESCE(campaign_status,'') || ':'
                 || COALESCE(spend::text,'') || ':' || COALESCE(revenue::text,'') || ':'
                 || COALESCE(impressions::text,'') || ':' || COALESCE(daily_budget::text,'') || ':'
                 || COALESCE(conversions::text,'') AS t
            FROM meta_campaign_daily WHERE business_id = $1
        ) c) AS campaign_md5,
       (SELECT COUNT(*) FROM meta_campaign_daily WHERE business_id = $1) AS campaign_rows,
       (SELECT COALESCE(md5(string_agg(t, '|' ORDER BY t)), '-') FROM (
          SELECT adset_id || ':' || date::text || ':' || COALESCE(adset_status,'') || ':'
                 || COALESCE(spend::text,'') || ':' || COALESCE(impressions::text,'') || ':'
                 || COALESCE(daily_budget::text,'') AS t
            FROM meta_adset_daily WHERE business_id = $1
        ) a) AS adset_md5,
       (SELECT COUNT(*) FROM meta_adset_daily WHERE business_id = $1) AS adset_rows,
       (SELECT COALESCE(md5(string_agg(t, '|' ORDER BY t)), '-') FROM (
          SELECT ad_id || ':' || date::text || ':' || COALESCE(ad_status,'') || ':'
                 || COALESCE(impressions::text,'') || ':' || COALESCE(spend::text,'') AS t
            FROM meta_ad_daily WHERE business_id = $1
        ) d) AS ad_md5,
       (SELECT COUNT(*) FROM meta_ad_daily WHERE business_id = $1) AS ad_rows`,
    [BUSINESS],
  )) as Array<Record<string, unknown>>;
  void asOf;
  return rows[0] ?? {};
}

/** What the surface and the queue would see, read back after each run. */
async function probeObservation(sql: ProbeSql, asOf: string) {
  /*
   * The card's own control, derived by the SAME function the served payload
   * uses. Printing it keeps this guide's "what the card offers" claim honest
   * across reruns instead of resting on a screenshot taken once.
   */
  const { serverOperatorApplyForRec } = await import("@/lib/meta/rec-presentation");
  const targetRows = (await sql.query(
    `SELECT rec_id, rec_type, scope_type, scope_id,
            COALESCE(target_value::text, 'NULL') AS target_value
       FROM meta_decision_snapshots_daily
      WHERE business_id = $1 AND snapshot_date = $2::date
        AND kind = 'recommendation' AND scope_type = 'adset' AND scope_id = $3
      ORDER BY rec_type`,
    [BUSINESS, asOf, CAPPED_ADSET],
  )) as Array<Record<string, unknown>>;
  const anomalyRows = (await sql.query(
    `SELECT rec_type, scope_type, scope_id,
            (resolved_at IS NOT NULL) AS resolved
       FROM meta_decision_snapshots_daily
      WHERE business_id = $1 AND snapshot_date = $2::date AND kind = 'anomaly'
      ORDER BY scope_id, rec_type`,
    [BUSINESS, asOf],
  )) as Array<Record<string, unknown>>;
  const proposalRows = (await sql.query(
    `SELECT status, proposed_action, decision_key, COUNT(*)::int AS n
       FROM meta_automation_proposals
      WHERE business_id = $1::uuid
      GROUP BY 1, 2, 3
      ORDER BY 2, 3, 1`,
    [BUSINESS],
  )) as Array<Record<string, unknown>>;
  const pending = proposalRows
    .filter((row) => row.status === "pending")
    .reduce((total, row) => total + Number(row.n ?? 0), 0);
  const bidIntent = targetRows
    .map((row) => {
      try {
        const parsed = JSON.parse(String(row.target_value)) as Record<string, unknown>;
        return parsed?.kind === "bid_intent" ? parsed : null;
      } catch {
        return null;
      }
    })
    .find((value) => value !== null) ?? null;
  const operatorApply = targetRows.map((row) => {
    let targetValue: unknown = null;
    try {
      targetValue = JSON.parse(String(row.target_value));
    } catch {
      targetValue = null;
    }
    const apply = serverOperatorApplyForRec({
      kind: "recommendation",
      level: "adset",
      proposedAction: undefined,
      campaignId: CAPPED_CAMPAIGN,
      adsetId: String(row.scope_id),
      targetValue,
    } as Parameters<typeof serverOperatorApplyForRec>[0]);
    return `${row.rec_type} -> ${apply ? JSON.stringify(apply) : "null"}`;
  });
  return {
    operatorApply,
    adsetTargetValues: targetRows.map((row) => ({
      recType: String(row.rec_type),
      targetValue: String(row.target_value).slice(0, 400),
    })),
    bidIntent: bidIntent
      ? {
        authorityStatus: bidIntent.authorityStatus,
        blockerCodes: bidIntent.blockerCodes,
        proposedMinorUnits: bidIntent.proposedMinorUnits,
        currentMinorUnits: bidIntent.currentMinorUnits,
      }
      : null,
    anomalyRows: anomalyRows.map((row) =>
      `${row.rec_type}:${row.scope_id}${row.resolved ? ":resolved" : ":open"}`),
    proposalRows: proposalRows.map((row) =>
      `${row.proposed_action}/${row.decision_key}/${row.status} x${row.n}`),
    pendingProposals: pending,
  };
}

async function runProbe(asOf: string) {
  const { getDb } = await import("@/lib/db");
  const { runMetaSnapshotForBusiness } = await import("@/lib/meta/snapshot");
  const { detectAnomaliesForBusiness, deliveryConstrainedAdsetIdsFrom } = await import(
    "@/lib/meta/anomalies"
  );
  const { readMetaCommercialTargets } = await import("@/lib/meta/commercial-targets");
  const { metaLossBudgetMaturity } = await import("@/lib/meta/commercial-targets");
  const sql = getDb() as unknown as ProbeSql;

  async function detectDirectly(label: string) {
    const targets = await readMetaCommercialTargets(BUSINESS, { asOf }).catch(() => null);
    const lossBudget = metaLossBudgetMaturity({ targets });
    // No `.catch` here on purpose: the production caller swallows a throw into
    // an empty list, and that is one of the two candidate explanations.
    const anomalies = await detectAnomaliesForBusiness({
      businessId: BUSINESS,
      snapshotDate: asOf,
      calibrationContext: null,
      profile: {
        lossBudgetSpend: lossBudget?.spendThreshold ?? null,
        timezone: "UTC",
      },
    });
    console.log(`  [${label}] detectAnomaliesForBusiness -> ${anomalies.length}`, JSON.stringify(
      anomalies.map((anomaly) => `${anomaly.type}:${anomaly.scopeType}:${anomaly.scopeId}:${anomaly.severity}`),
    ));
    console.log(
      `  [${label}] deliveryConstrainedAdsetIds ->`,
      JSON.stringify([...deliveryConstrainedAdsetIdsFrom(anomalies)]),
    );
    return anomalies;
  }

  async function oneRun(label: string) {
    console.log("");
    console.log(`── ${label} ─────────────────────────────────────────────`);
    console.log(`  fact fingerprint  ${JSON.stringify(await warehouseFactFingerprint(sql, asOf))}`);
    await detectDirectly(label);
    const run = await runMetaSnapshotForBusiness(BUSINESS, asOf);
    console.log(`  anomaliesWritten  ${run.anomaliesWritten}`);
    console.log(`  bidProposals      ${JSON.stringify(run.bidProposals)}`);
    console.log(`  budgetProposals   ${JSON.stringify(run.budgetProposals)}`);
    console.log(`  proposals(pause)  ${JSON.stringify(run.proposals)}`);
    const observed = await probeObservation(sql, asOf);
    console.log(`  adset target_value ${JSON.stringify(observed.adsetTargetValues)}`);
    console.log(`  bid intent        ${JSON.stringify(observed.bidIntent)}`);
    console.log(`  card operatorApply ${JSON.stringify(observed.operatorApply)}`);
    console.log(`  anomaly rows      ${JSON.stringify(observed.anomalyRows)}`);
    console.log(`  proposal rows     ${JSON.stringify(observed.proposalRows)}`);
    console.log(`  pending proposals ${observed.pendingProposals}`);
    return { run, observed };
  }

  /*
   * The constraints that make "no duplicate execution" a database fact rather
   * than a claim, printed from the migrated schema rather than from memory.
   */
  const indexes = (await sql.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'meta_automation_proposals' AND indexdef LIKE '%UNIQUE%'
      ORDER BY indexname`,
  )) as Array<{ indexname: string; indexdef: string }>;
  console.log("");
  console.log("── unique constraints on meta_automation_proposals ──");
  for (const index of indexes) {
    console.log(`  ${index.indexname}`);
    console.log(`    ${index.indexdef.replace(/^CREATE UNIQUE INDEX \S+ ON \S+ /, "")}`);
  }

  const first = await oneRun("RUN 1");
  const second = await oneRun("RUN 2 (identical facts)");

  /*
   * The settled-slot rerun, which is the sequence the harness guide's own
   * walkthrough puts an operator through: approve and apply, then run the
   * snapshot again. It is the case the deleted guidance was really about, so
   * it is graded here rather than assumed.
   *
   * `settleMetaAutomationProposal` is the shipped settle the apply route uses,
   * driven directly because the route needs a session; the row it leaves
   * behind is the same row.
   */
  console.log("");
  console.log("── the operator applies: the pending bid row is settled 'approved' ──");
  const { settleMetaAutomationProposal } = await import("@/lib/meta/automation-proposals");
  const pendingRows = (await sql.query(
    `SELECT id::text AS id FROM meta_automation_proposals
      WHERE business_id = $1::uuid AND status = 'pending' AND proposed_action = 'bid'`,
    [BUSINESS],
  )) as Array<{ id: string }>;
  for (const row of pendingRows) {
    await settleMetaAutomationProposal({
      businessId: BUSINESS,
      proposalId: row.id,
      status: "approved",
      decidedBy: OPERATOR,
      decisionNote: "rerun probe",
      /*
       * The settle's own receipt shape, filled honestly: this probe does not
       * dispatch to the double, so the endpoint is null and `withheld` names
       * why. A `{ probe: true }` blob would not type-check and, worse, would
       * put a receipt in the row that no dispatch ever produced.
       */
      receipt: {
        httpStatus: 200,
        response: { source: "rerun_probe" },
        dryRun: false,
        dispatchedAt: new Date().toISOString(),
        endpoint: null,
        withheld: "rerun_probe_settles_without_dispatch",
      },
    });
  }
  const applied = await oneRun("RUN 3 (same facts, slot already applied)");

  /*
   * The third run is the falsifier. Without it "stable" and "frozen" look the
   * same: restore the stalled ad set's impressions to its own seven-day median
   * and the delivery evidence must genuinely disappear.
   */
  console.log("");
  console.log("── fact change: the stall is over (impressions 500 -> 4000) ──");
  await sql.query(
    `UPDATE meta_adset_daily SET impressions = 4000
      WHERE business_id = $1 AND adset_id = $2 AND date = $3::date`,
    [BUSINESS, CAPPED_ADSET, asOf],
  );
  const recovered = await oneRun("RUN 4 (stall resolved)");

  console.log("");
  console.log("──────────────────────── summary ────────────────────────");
  for (const [label, entry] of [
    ["run 1                     ", first],
    ["run 2 (identical facts)   ", second],
    ["run 3 (slot applied)      ", applied],
    ["run 4 (stall resolved)    ", recovered],
  ] as const) {
    console.log(
      `  ${label}: anomaliesWritten=${entry.run.anomaliesWritten} ` +
      `bid=${JSON.stringify(entry.run.bidProposals)} ` +
      `budget=${JSON.stringify(entry.run.budgetProposals)} ` +
      `bidIntent=${entry.observed.bidIntent ? entry.observed.bidIntent.proposedMinorUnits : "none"} ` +
      `pending=${entry.observed.pendingProposals}`,
    );
  }
  console.log("─────────────────────────────────────────────────────────");
}

/* -------------------------------------------------- clock rerun probe */

/*
  A same-day rerun at a different HOUR, which `--rerun-probe` structurally
  cannot show.

  That probe grades `delivery_stall`, a family that reads only the warehouse,
  on a snapshot date that is always yesterday. Two families are gated on the
  time of day instead, and a closed day puts them permanently outside the gate,
  so the loss they used to cause never appeared in its table:

    - a snapshot at 08:00 local writes a high-severity `budget_exhausted_early`
      row for a campaign at 96/100 of its daily budget;
    - a rerun at 22:00 the SAME day, warehouse rows byte-identical, cannot
      judge the family at all — 92% of the local day is outside the 20%–90%
      window in which "early" means anything;
    - the writer used to stamp `resolved_at` on the open row because it was
      absent from the second run's payload, and the workspace serves
      `resolved_at IS NULL` as `open`, so the operator's anomaly vanished on a
      rerun with no fact change.

  The fix is that `detectAnomalyEvaluationForBusiness` reports `evaluatedTypes`
  separately from the anomalies, and the writer's resolve step is scoped to
  those families. This mode drives the SHIPPED `runMetaSnapshotForBusiness` at
  four injected wall clocks and prints the rows so the claim is a measurement.

  The clock is injected by replacing the global `Date`, not by sleeping: the
  snapshot samples `new Date()` inside the detector and there is no parameter
  to pass it through.
*/
const CLOCK_PROBE_BUSINESS = "9f1c0d2e-0000-4000-8000-00000000c10c";
const CLOCK_PROBE_OWNER = "9f1c0d2e-0000-4000-8000-00000000c0f0";
const CLOCK_PROBE_ACCOUNT = "act_9000000000900";
const CLOCK_PROBE_DATE = "2026-09-06";
/** UTC+3 all year, so the local date never disagrees with the two clocks below. */
const CLOCK_PROBE_ZONE = "Europe/Istanbul";

const RealDate = Date;
function withInjectedClock(iso: string) {
  const fixed = new RealDate(iso).getTime();
  class InjectedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) super(fixed);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static now() {
      return fixed;
    }
  }
  (globalThis as unknown as { Date: DateConstructor }).Date =
    InjectedDate as unknown as DateConstructor;
}
function restoreRealClock() {
  (globalThis as unknown as { Date: DateConstructor }).Date = RealDate;
}

async function runClockRerunProbe() {
  const { getDb } = await import("@/lib/db");
  const { runMetaSnapshotForBusiness } = await import("@/lib/meta/snapshot");
  const sql = getDb() as unknown as ProbeSql;

  await sql.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1, 'Clock probe', 'clock-probe@adsecute.test', 'x')
     ON CONFLICT DO NOTHING`,
    [CLOCK_PROBE_OWNER],
  );
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, timezone, currency, is_demo_business)
     VALUES ($1, 'Clock rerun probe', $2, $3, 'USD', FALSE)
     ON CONFLICT DO NOTHING`,
    [CLOCK_PROBE_BUSINESS, CLOCK_PROBE_OWNER, CLOCK_PROBE_ZONE],
  );
  /*
    96 of a 100 daily budget, ACTIVE, on the snapshot date. One day only: with
    no history the four warehouse-pure families have nothing to say, so every
    row printed below belongs to the family under test.
  */
  await sql.query(
    `INSERT INTO meta_campaign_daily
       (business_id, provider_account_id, date, campaign_id, campaign_name_current,
        campaign_status, daily_budget, account_timezone, account_currency,
        spend, impressions, clicks, reach, conversions, revenue, roas)
     VALUES ($1, $2, $3::date, 'cmp_clock', 'Prospecting', 'ACTIVE', 100, $4, 'USD',
        96, 10000, 100, 8000, 4, 300, 3.125)
     ON CONFLICT DO NOTHING`,
    [CLOCK_PROBE_BUSINESS, CLOCK_PROBE_ACCOUNT, CLOCK_PROBE_DATE, CLOCK_PROBE_ZONE],
  );

  async function factFingerprint() {
    const rows = (await sql.query(
      `SELECT COALESCE(md5(string_agg(
         campaign_id || '|' || spend || '|' || daily_budget || '|' || campaign_status,
         ',' ORDER BY campaign_id)), '-') AS fingerprint
       FROM meta_campaign_daily WHERE business_id = $1 AND date = $2::date`,
      [CLOCK_PROBE_BUSINESS, CLOCK_PROBE_DATE],
    )) as Array<{ fingerprint: string }>;
    return rows[0]?.fingerprint ?? "-";
  }

  async function anomalyRows() {
    return (await sql.query(
      `SELECT rec_type, scope_id, severity,
              detected_at::text AS detected_at, resolved_at::text AS resolved_at
       FROM meta_decision_snapshots_daily
       WHERE business_id = $1 AND kind = 'anomaly' AND snapshot_date = $2::date
       ORDER BY rec_type, scope_id`,
      [CLOCK_PROBE_BUSINESS, CLOCK_PROBE_DATE],
    )) as Array<{
      rec_type: string;
      scope_id: string;
      severity: string | null;
      detected_at: string | null;
      resolved_at: string | null;
    }>;
  }

  async function oneRun(label: string, clock: string) {
    console.log("");
    console.log(`── ${label} ─────────────────────────────────────────`);
    console.log(`  injected wall clock  ${clock}`);
    console.log(`  fact fingerprint     ${await factFingerprint()}`);
    withInjectedClock(clock);
    let run;
    try {
      run = await runMetaSnapshotForBusiness(CLOCK_PROBE_BUSINESS, CLOCK_PROBE_DATE);
    } finally {
      restoreRealClock();
    }
    console.log(`  anomaliesWritten     ${run.anomaliesWritten}`);
    for (const row of await anomalyRows()) {
      console.log(
        `  row  ${row.rec_type}/${row.scope_id} severity=${row.severity} ` +
        `detected=${row.detected_at} ${row.resolved_at ? `RESOLVED at ${row.resolved_at}` : "OPEN"}`,
      );
    }
    return run;
  }

  await oneRun("RUN 1  08:00 local (33% of the day — inside the gate)", "2026-09-06T05:00:00.000Z");
  await oneRun("RUN 2  22:00 local, SAME day, identical facts (92% — outside it)", "2026-09-06T19:00:00.000Z");
  await oneRun("RUN 3  the next day, so the snapshot date is now PAST", "2026-09-07T05:00:00.000Z");

  /*
    The falsifier. Without it, "never resolves" and "resolves only what it
    evaluated" look identical, and deleting the resolve step entirely would
    produce the same first three runs.
  */
  console.log("");
  console.log("── fact change: spend 96 -> 10, the campaign is no longer exhausted ──");
  await sql.query(
    `UPDATE meta_campaign_daily SET spend = 10
     WHERE business_id = $1 AND date = $2::date`,
    [CLOCK_PROBE_BUSINESS, CLOCK_PROBE_DATE],
  );
  await oneRun("RUN 4  08:00 local again, facts moved", "2026-09-06T05:00:00.000Z");

  console.log("");
  console.log("─────────────────────────────────────────────────────────");
  console.log(" Runs 1-3 must leave the row OPEN (the family could not be judged);");
  console.log(" run 4 must RESOLVE it (the family was judged and the condition is over).");
  console.log("─────────────────────────────────────────────────────────");
}

/**
 * One throwaway cluster, migrated by the repo's own deploy entry point.
 *
 * Shared by the standing fixture and the rerun probe so there is exactly one
 * place where the port safety rule and the pre-set `DATABASE_URL` live.
 */
async function bringUpCluster(rootDir: string, pgBinDir: string) {
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
  return { port, dataDir, databaseUrl, state };
}

/* ------------------------------------------- decision availability matrix */

/**
 * The availability matrix.
 *
 * The question it answers is the one the product owner keeps asking: with
 * adequate fresh evidence in front of it, does this engine produce a CONCRETE
 * recommendation, or does everything decay into a generic "extra review
 * needed"? That cannot be settled by reading code, because every posture
 * control in the product sits on a different layer — the standing decision
 * mode gates the QUEUE producer, the business STOP and the release gate sit in
 * front of the DISPATCH, and the `dryRunOnly` guardrail decides whether a
 * dispatch reaches a provider at all. Any of them could, in principle, reach
 * back and change the DECISION. Only measuring says which do.
 *
 * So the facts are held fixed and the posture is varied:
 *
 *   mode        manual | semi_auto | auto     (all four families together)
 *   STOP        released | engaged
 *   rehearsal   dryRunOnly false | true
 *   master      META_AUTOMATION_LIVE_WRITES false | true
 *
 * 3 x 2 x 2 x 2 = 24 cells. Each one gets its own DATABASE, cloned from a
 * single seeded template with `CREATE DATABASE ... TEMPLATE`, so "the facts are
 * identical" is a property of the clone rather than a claim about the seeder.
 * Each cell then runs in its own CHILD PROCESS, because the release gate is
 * read from the environment and `readMetaReleaseGates` is memoised per process:
 * flipping it inside one process would grade a value the app never saw.
 *
 * Per cell the child drives, in this order and no other:
 *
 *   1. the real producer     `runMetaSnapshotForBusiness`
 *   2. the retained snapshot `meta_decision_snapshots_daily` (read back)
 *   3. the served card       `GET /api/meta/decisions-workspace`, the shipped
 *                            route handler, invoked with a REAL session cookie
 *   4. the dispatch          `POST /api/meta/automation/proposals` with the
 *                            shipped `explicit_operator_confirmation`
 *
 * Nothing about a cell is asserted here. The child prints what it observed and
 * the parent tabulates it; a cell that degrades shows up as a different
 * recommendation fingerprint, and the fingerprint is over the recommendation,
 * its evidence and its sizing — never over the CTA.
 */

/** The four postures one cell holds. */
interface MatrixPosture {
  mode: "manual" | "semi_auto" | "auto";
  stop: boolean;
  rehearsal: boolean;
  master: boolean;
}

function matrixCellId(posture: MatrixPosture) {
  return [
    posture.mode,
    posture.stop ? "stop" : "released",
    posture.rehearsal ? "rehearsal" : "live",
    posture.master ? "master_on" : "master_off",
  ].join("__");
}

function matrixCells(): MatrixPosture[] {
  const cells: MatrixPosture[] = [];
  for (const mode of ["manual", "semi_auto", "auto"] as const) {
    for (const stop of [false, true]) {
      for (const rehearsal of [false, true]) {
        for (const master of [true, false]) {
          cells.push({ mode, stop, rehearsal, master });
        }
      }
    }
  }
  return cells;
}

/**
 * Keys whose value is a wall clock, not a decision.
 *
 * The invariant under test is that the RECOMMENDATION, its EVIDENCE and its
 * SIZING do not move with posture. A payload also carries the instant it was
 * generated, and two cells cannot share one of those because they run seconds
 * apart. Stripping them is therefore required for the comparison to mean
 * anything — but stripping anything else would be hiding a difference, so the
 * list is short, explicit, and printed in the report beside the fingerprint it
 * produced.
 */
const MATRIX_VOLATILE_KEYS = new Set([
  "knowledgeAsOf",
  "generatedAt",
  "createdAt",
  "updatedAt",
  "observedAt",
  "decidedAt",
  "dispatchedAt",
  "snapshotCreatedAt",
  "evaluatedAt",
  "asOf",
  "sampledAt",
]);

function matrixStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(matrixStable);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (MATRIX_VOLATILE_KEYS.has(key)) continue;
      out[key] = matrixStable(source[key]);
    }
    return out;
  }
  return value;
}

function matrixDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(matrixStable(value)))
    .digest("hex")
    .slice(0, 16);
}

/**
 * One served row, reduced to the four questions the matrix asks of it.
 *
 * `concrete` is not "the card said something confident": it is an
 * operator-applyable typed verb with an amount where the verb carries one,
 * derived by the surface's OWN `serverOperatorApplyForRec` from the persisted
 * row. `hold` is a row the engine deliberately did not act on and said why.
 * `missing_data` is a row whose automation readiness names an OPERATIONAL
 * blocker — something an operator could supply — as opposed to the research
 * programme's own blockers, which are true of nearly every row and which the
 * product already folds into one sentence.
 */
type MatrixRowBucket = "concrete" | "hold_or_watch" | "missing_data" | "state_only";

/**
 * Blockers grouped by what an operator could DO about them.
 *
 * The served rows carry one flat `blockers` array, and reading a count off it
 * says nothing: `missing_live_preflight` is on every row in the product and is
 * a condition of UNATTENDED execution, while `campaign_context_unresolved`
 * names an input this account is actually missing. Counting them together is
 * exactly how a matrix would manufacture the answer "everything is blocked".
 *
 * So they are split three ways and each cell reports all three:
 *
 *   PROGRAMME      the automation research conditions. True of nearly every
 *                  row; the product already folds them into one sentence.
 *   PREREQUISITE   what unattended execution needs before it may run itself.
 *                  Never a statement about this account's data, and never a
 *                  reason an OPERATOR cannot apply the row by hand.
 *   POSTURE        what the decision itself is: not an act-now row, a watch
 *                  row, an action class with no executor, below the confidence
 *                  floor. A description, not an absence.
 *
 * Anything left over is genuinely missing account data, and only that counts
 * into the `missing_data` bucket.
 */
const MATRIX_PREREQUISITE_BLOCKERS = new Set([
  "missing_live_preflight",
  "missing_rollback_plan",
  "missing_operator_enablement",
  "missing_executor",
]);

const MATRIX_POSTURE_BLOCKERS = new Set([
  "not_action_state",
  "diagnostic_or_watch_state",
  "unsupported_action_class",
  "low_confidence",
]);

interface MatrixServedRow {
  recId: string;
  kind: string;
  level: string;
  scopeId: string | null;
  type: string;
  lane: string;
  decisionLabel: string | null;
  decisionState: string | null;
  actionKind: string | null;
  primaryActionLabel: string | null;
  operatorApply: unknown;
  appliedAmountMinor: number | null;
  intent: {
    kind: string | null;
    authorityStatus: string | null;
    blockerCodes: string[];
    proposedMinorUnits: number | null;
    currentMinorUnits: number | null;
    currency: string | null;
    sizingPolicyVersion: string | null;
  } | null;
  /** Named inputs this ACCOUNT is missing. The only ones `missing_data` counts. */
  missingDataBlockers: string[];
  prerequisiteBlockers: string[];
  postureBlockers: string[];
  programmaticBlockers: string[];
  evidenceLabels: string[];
  hardActionAuthority: string | null;
  hardActionBlocker: string | null;
  campaignContextAuthority: string | null;
  stateReason: string | null;
  warnLine: string | null;
  reasoning: string | null;
  bucket: MatrixRowBucket;
}

const MATRIX_PROGRAMMATIC_BLOCKERS = new Set([
  "no_empirical_outcome_model",
  "missing_controlled_causal_evidence",
  "missing_valid_treatment_receipt",
  "missing_valid_random_assignment",
  "missing_valid_control_estimate",
  "insufficient_empirical_sample",
  "empirical_precision_below_floor",
  "missing_holdout_plan",
  "missing_post_action_monitor",
]);

/**
 * Which of the four questions this row answers.
 *
 * Order matters and is argued rather than convenient. A row that offers a
 * typed verb with an amount is CONCRETE even when its automation readiness is
 * blocked, because the operator can apply it today — conflating the two is the
 * error that makes an engine look like it recommends nothing. A `state` or
 * `anomaly` row is a condition and is counted separately from a decision that
 * was deliberately held. Missing DATA beats hold, because a row waiting on an
 * input is not the same as a row the engine chose not to act on.
 */
function matrixClassifyRow(row: {
  kind: string;
  operatorApply: unknown;
  missingDataBlockers: string[];
  hardActionBlocker: string | null;
}): MatrixRowBucket {
  if (row.operatorApply) return "concrete";
  if (row.kind === "state" || row.kind === "anomaly") return "state_only";
  if (row.missingDataBlockers.length > 0 || row.hardActionBlocker) return "missing_data";
  return "hold_or_watch";
}

/**
 * The cell child. Everything it touches is the shipped path.
 */
async function runMatrixCell() {
  const posture = JSON.parse(
    process.env.MATRIX_CELL ?? "{}",
  ) as MatrixPosture;
  const outFile = process.env.MATRIX_OUT ?? "";
  if (!outFile) fail("MATRIX_OUT is required for a matrix cell.");
  const asOf = process.env.MATRIX_AS_OF ?? resolveAsOf();

  const { getDb } = await import("@/lib/db");
  const { runMetaSnapshotForBusiness } = await import("@/lib/meta/snapshot");
  const { createSession } = await import("@/lib/auth");
  const { getMetaAutomationControlPlane, resolveEffectiveMetaModes } = await import(
    "@/lib/meta/automation-control-plane"
  );
  const { readMetaReleaseGates } = await import("@/lib/meta/release-gates");
  const sql = getDb() as unknown as ProbeSql;

  /* ---------------------------------------------------------- the posture */
  /*
    Written with the same columns the Automation screen writes, and nothing
    else. STOP carries a reason because a STOP without one is not the state an
    operator can ever produce through the ceremony.
  */
  await sql.query(
    `UPDATE meta_automation_business_controls
        SET kill_switch_engaged = $2,
            kill_switch_reason = $3,
            guardrails_json = jsonb_set(guardrails_json, '{dryRunOnly}', $4::jsonb, true)
      WHERE business_id = $1::uuid`,
    [
      BUSINESS,
      posture.stop,
      posture.stop ? "availability matrix: STOP engaged for this cell" : null,
      JSON.stringify(posture.rehearsal),
    ],
  );
  for (const decisionType of ["pause", "bid", "budget", "creative"]) {
    await sql.query(
      `INSERT INTO meta_automation_decision_type_modes (business_id, decision_type, mode)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT (business_id, decision_type) DO UPDATE SET mode = EXCLUDED.mode`,
      [BUSINESS, decisionType, posture.mode],
    );
  }

  const factFingerprint = await warehouseFactFingerprint(sql, asOf);

  /* ------------------------------------------------------- 1. the producer */
  const run = await runMetaSnapshotForBusiness(BUSINESS, asOf);

  /* ----------------------------------------------- 2. the retained snapshot */
  const retained = (await sql.query(
    `SELECT rec_id, kind, rec_type, scope_type, scope_id,
            COALESCE(target_value::text, 'null') AS target_value,
            COALESCE(reasoning, '') AS reasoning
       FROM meta_decision_snapshots_daily
      WHERE business_id = $1 AND snapshot_date = $2::date
      ORDER BY kind, scope_type, scope_id, rec_type`,
    [BUSINESS, asOf],
  )) as Array<Record<string, unknown>>;

  /* ---------------------------------------------------------- 3. the card */
  const session = await createSession({
    userId: OPERATOR,
    activeBusinessId: BUSINESS,
  });
  const { NextRequest } = await import("next/server");
  const { GET } = await import("@/app/api/meta/decisions-workspace/route");
  const url =
    `http://127.0.0.1/api/meta/decisions-workspace`
    + `?businessId=${BUSINESS}&providerAccountId=${ACCOUNT}&window=28d`;
  const request = new NextRequest(url, {
    headers: { cookie: `omniads_session=${session.token}` },
  });
  const response = await GET(request);
  const payload = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;

  const lanes = (payload?.lanes ?? null) as Record<string, unknown> | null;
  const servedRows: MatrixServedRow[] = [];
  for (const lane of ["actionNow", "watching", "nonSales"]) {
    const rows = (lanes?.[lane] ?? []) as Array<Record<string, unknown>>;
    for (const rec of rows) {
      const target = (rec.targetValue ?? null) as Record<string, unknown> | null;
      const readiness = (rec.automationReadiness ?? null) as
        | { blockers?: string[] }
        | null;
      const blockers = (readiness?.blockers ?? []).filter(
        (blocker) => typeof blocker === "string" && blocker.trim().length > 0,
      );
      const programmatic = blockers.filter((blocker) =>
        MATRIX_PROGRAMMATIC_BLOCKERS.has(blocker),
      );
      const prerequisite = blockers.filter((blocker) =>
        MATRIX_PREREQUISITE_BLOCKERS.has(blocker),
      );
      const postureBlockers = blockers.filter((blocker) =>
        MATRIX_POSTURE_BLOCKERS.has(blocker),
      );
      const missingData = blockers.filter(
        (blocker) =>
          !MATRIX_PROGRAMMATIC_BLOCKERS.has(blocker)
          && !MATRIX_PREREQUISITE_BLOCKERS.has(blocker)
          && !MATRIX_POSTURE_BLOCKERS.has(blocker),
      );
      const signalQuality = (rec.signalQuality ?? {}) as Record<string, unknown>;
      const evidenceItems = Array.isArray(rec.evidence)
        ? (rec.evidence as Array<{ label?: unknown }>)
        : [];
      const operatorApply = rec.operatorApply ?? null;
      const rowPresentation = (rec.rowPresentation ?? null) as
        | { warnLine?: string | null }
        | null;
      const intent = target && typeof target.kind === "string"
        ? {
          kind: String(target.kind),
          authorityStatus: (target.authorityStatus as string | null) ?? null,
          blockerCodes: Array.isArray(target.blockerCodes)
            ? (target.blockerCodes as string[])
            : [],
          proposedMinorUnits: typeof target.proposedMinorUnits === "number"
            ? target.proposedMinorUnits
            : null,
          currentMinorUnits: typeof target.currentMinorUnits === "number"
            ? target.currentMinorUnits
            : null,
          currency: (target.currency as string | null) ?? null,
          sizingPolicyVersion: (target.sizingPolicyVersion as string | null) ?? null,
        }
        : null;
      const applied = operatorApply
        && typeof (operatorApply as { bidAmountMinor?: unknown }).bidAmountMinor === "number"
        ? Number((operatorApply as { bidAmountMinor: number }).bidAmountMinor)
        : null;
      servedRows.push({
        recId: String(rec.id ?? rec.recId ?? ""),
        kind: String(rec.kind ?? ""),
        level: String(rec.level ?? ""),
        scopeId: (rec.adsetId as string | null) ?? (rec.campaignId as string | null) ?? null,
        type: String(rec.type ?? ""),
        lane,
        decisionLabel: (rec.decisionLabel as string | null) ?? null,
        decisionState: (rec.decisionState as string | null) ?? null,
        actionKind: (rec.actionKind as string | null) ?? null,
        primaryActionLabel: (rec.primaryActionLabel as string | null) ?? null,
        operatorApply,
        appliedAmountMinor: applied,
        intent,
        missingDataBlockers: missingData,
        prerequisiteBlockers: prerequisite,
        postureBlockers,
        programmaticBlockers: programmatic,
        evidenceLabels: evidenceItems
          .map((item) => String(item?.label ?? ""))
          .filter((label) => label.length > 0),
        hardActionAuthority:
          typeof signalQuality.hard_action_authority === "string"
            ? signalQuality.hard_action_authority
            : null,
        hardActionBlocker:
          typeof signalQuality.hard_action_blocker === "string"
            ? signalQuality.hard_action_blocker
            : null,
        campaignContextAuthority:
          typeof signalQuality.campaign_context_action_authority === "string"
            ? signalQuality.campaign_context_action_authority
            : null,
        stateReason: (rec.stateReason as string | null) ?? null,
        warnLine: rowPresentation?.warnLine ?? null,
        reasoning: (rec.reasoning as string | null) ?? null,
        bucket: matrixClassifyRow({
          kind: String(rec.kind ?? ""),
          operatorApply,
          missingDataBlockers: missingData,
          hardActionBlocker:
            typeof signalQuality.hard_action_blocker === "string"
              ? signalQuality.hard_action_blocker
              : null,
        }),
      });
    }
  }

  /*
    The serve-scope reproduction, driven on the shipped reader.

    The lane serve path calls `readMetaDecisionSnapshotForRange` WITHOUT a
    provider account (`app/api/meta/lane-classify/route.ts`), because lane
    classification is business-wide by design. That same null then travels into
    the campaign-context read inside the reader, and that read IS account
    scoped — so it returns an empty label map, every hard action looks
    unlabeled, and `applyMetaCampaignLabelGuard` downgrades it to
    `campaign_context_action_authority: "review_only"`.

    Driving the same function twice, once with the account and once without,
    is what separates "this account has no campaign role" from "the serve path
    could not see the role it has". It is recorded per cell so the finding is
    reproducible by the same one command as the rest of the matrix.
  */
  const { readMetaDecisionSnapshotForRange } = await import("@/lib/meta/snapshot");
  const scopeWindow = {
    businessId: BUSINESS,
    startDate: addDays(asOf, -(WINDOW_DAYS - 1)),
    endDate: asOf,
  };
  const scopeProbe = async (providerAccountId: string | null) => {
    const read = await readMetaDecisionSnapshotForRange({
      ...scopeWindow,
      providerAccountId,
    }).catch(() => null);
    return (read?.recommendations ?? [])
      .filter((rec) => rec.kind !== "state" && rec.kind !== "anomaly")
      .map((rec) => ({
        type: rec.type,
        campaignId: rec.campaignId ?? null,
        decisionState: rec.decisionState ?? null,
        confidence: rec.confidence ?? null,
        campaignContextAuthority:
          (rec.signalQuality as Record<string, unknown> | undefined)
            ?.campaign_context_action_authority ?? null,
        campaignKind: rec.campaignKind ?? null,
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  };
  const serveScope = {
    withAccount: await scopeProbe(ACCOUNT),
    withoutAccount: await scopeProbe(null),
    laneServePathPasses: "no providerAccountId (app/api/meta/lane-classify/route.ts)",
  };

  /* --------------------------------------------------------- 4. the queue */
  const queueRows = (await sql.query(
    `SELECT id::text AS id, proposed_action, origin, status, decision_key,
            scope_type, scope_id, action_label
       FROM meta_automation_proposals
      WHERE business_id = $1::uuid
      ORDER BY proposed_action, decision_key, status`,
    [BUSINESS],
  )) as Array<Record<string, unknown>>;

  const control = await getMetaAutomationControlPlane({
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
  }).catch(() => null);
  const modes = await resolveEffectiveMetaModes(BUSINESS).catch(() => null);

  /* ------------------------------------------------------ 5. the dispatch */
  /*
    The one act that can reach a provider, driven through the shipped route so
    the refusal codes are the product's own rather than this file's opinion of
    them. Nothing here forces a dispatch: when the mode raised no queue row
    there is nothing to approve, and that is itself the measurement.
  */
  const pendingBid = queueRows.find(
    (row) => row.status === "pending" && row.proposed_action === "bid",
  );
  let dispatch: Record<string, unknown> = {
    attempted: false,
    reason: pendingBid ? "not_attempted" : "no_pending_queue_row",
  };
  if (pendingBid) {
    const { POST } = await import("@/app/api/meta/automation/proposals/route");
    const approveUrl =
      `http://127.0.0.1/api/meta/automation/proposals`
      + `?businessId=${BUSINESS}&providerAccountId=${ACCOUNT}`;
    const approveRequest = new NextRequest(approveUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `omniads_session=${session.token}`,
      },
      body: JSON.stringify({
        action: "approve",
        proposalId: String(pendingBid.id),
        manualConfirmation: "explicit_operator_confirmation",
      }),
    });
    const approveResponse = await POST(approveRequest);
    const approveBody = (await approveResponse.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const settled = (await sql.query(
      `SELECT status, COALESCE(receipt_json::text, 'null') AS receipt
         FROM meta_automation_proposals WHERE id = $1::uuid`,
      [String(pendingBid.id)],
    )) as Array<Record<string, unknown>>;
    dispatch = {
      attempted: true,
      httpStatus: approveResponse.status,
      errorCode: approveBody?.error ?? null,
      bodyKeys: approveBody ? Object.keys(approveBody).sort() : [],
      dryRun: (approveBody?.receipt as { dryRun?: unknown } | undefined)?.dryRun
        ?? null,
      settledStatus: settled[0]?.status ?? null,
      settledReceipt: settled[0]?.receipt ?? null,
    };
  }

  const ledger = (await sql.query(
    `SELECT activity_type, severity,
            COALESCE(payload_json ->> 'resultStatus', '') AS result_status,
            COALESCE(payload_json ->> 'errorCode', '') AS error_code,
            COALESCE(payload_json ->> 'dryRun', '') AS dry_run
       FROM meta_automation_activity_ledger
      WHERE business_id = $1::uuid
      ORDER BY created_at`,
    [BUSINESS],
  )) as Array<Record<string, unknown>>;

  /*
    The fingerprint the whole matrix turns on.

    It covers the recommendation identity, the evidence sentence and the sized
    amount — exactly the three things that must not move with posture — and
    NOTHING about dispatch or CTA. `retainedDigest` is the same question asked
    of the persisted rows rather than of the served payload, so a surface that
    quietly re-derived something cannot hide behind the database agreeing.
  */
  const decisionDigest = matrixDigest(
    servedRows
      .map((row) => ({
        recId: row.recId,
        type: row.type,
        level: row.level,
        scopeId: row.scopeId,
        decisionLabel: row.decisionLabel,
        decisionState: row.decisionState,
        reasoning: row.reasoning,
        intent: row.intent,
        evidenceLabels: [...row.evidenceLabels].sort(),
        stateReason: row.stateReason,
        missingDataBlockers: [...row.missingDataBlockers].sort(),
        prerequisiteBlockers: [...row.prerequisiteBlockers].sort(),
        postureBlockers: [...row.postureBlockers].sort(),
        hardActionBlocker: row.hardActionBlocker,
        campaignContextAuthority: row.campaignContextAuthority,
      }))
      .sort((a, b) => a.recId.localeCompare(b.recId)),
  );
  const retainedDigest = matrixDigest(
    retained.map((row) => ({
      recId: row.rec_id,
      kind: row.kind,
      recType: row.rec_type,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      reasoning: row.reasoning,
      targetValue: JSON.parse(String(row.target_value)),
    })),
  );
  const ctaDigest = matrixDigest(
    servedRows
      .map((row) => ({
        recId: row.recId,
        actionKind: row.actionKind,
        primaryActionLabel: row.primaryActionLabel,
        operatorApply: row.operatorApply,
      }))
      .sort((a, b) => a.recId.localeCompare(b.recId)),
  );

  const result = {
    cell: matrixCellId(posture),
    posture,
    asOf,
    factFingerprint,
    releaseGates: readMetaReleaseGates(),
    effectiveModes: modes,
    snapshotRun: {
      anomaliesWritten: run.anomaliesWritten,
      recommendationsWritten: run.recommendationsWritten,
      bidProposals: run.bidProposals,
      budgetProposals: run.budgetProposals,
      pauseProposals: run.proposals,
      launchProposals: run.launchProposals,
      activationProposals: run.activationProposals,
    },
    served: {
      httpStatus: response.status,
      banners: (payload?.banners ?? null),
      commercialAnchor: ((payload?.system ?? null) as
        { commercialAnchor?: unknown } | null)?.commercialAnchor ?? null,
      laneCounts: (lanes?.counts ?? null),
      actionStates: ((payload?.queue ?? null) as { actionStates?: unknown } | null)
        ?.actionStates ?? null,
      rowCount: servedRows.length,
      rows: servedRows,
    },
    retainedRowCount: retained.length,
    serveScope,
    queue: {
      rows: queueRows.map((row) =>
        `${row.proposed_action}/${row.decision_key}/${row.status}`),
      pending: queueRows.filter((row) => row.status === "pending").length,
    },
    controlPlane: control
      ? {
        source: control.businessControl.source,
        killSwitchEngaged: control.businessControl.killSwitchEngaged,
        readinessTier: control.businessControl.readinessTier,
        dryRunOnly: control.businessControl.guardrails.dryRunOnly,
        execution: control.execution,
      }
      : null,
    dispatch,
    ledger,
    digests: {
      decision: decisionDigest,
      retained: retainedDigest,
      cta: ctaDigest,
    },
  };

  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), "utf8");
  log(`cell ${matrixCellId(posture)} -> ${outFile}`);
  process.exit(0);
}

/** The seed child: the same fixture, into whatever DATABASE_URL it is given. */
async function runMatrixSeed() {
  const asOf = process.env.MATRIX_AS_OF ?? resolveAsOf();
  await seed(asOf, { runSnapshot: false });
  log(`matrix template seeded for ${asOf}`);
  process.exit(0);
}

function matrixBucketCounts(rows: MatrixServedRow[]) {
  const counts = {
    concrete: 0,
    hold_or_watch: 0,
    missing_data: 0,
    state_only: 0,
  };
  for (const row of rows) counts[row.bucket] += 1;
  return counts;
}

async function runAvailabilityMatrix(rootDir: string, pgBinDir: string, keep: boolean) {
  const matrixRoot = `${rootDir}-availability-matrix`;
  const previous = readState(matrixRoot);
  if (previous) {
    stopCluster(previous, pgBinDir);
    fs.rmSync(matrixRoot, { recursive: true, force: true });
  }
  const cluster = await bringUpCluster(matrixRoot, pgBinDir);
  const asOf = resolveAsOf();
  const { CAMPAIGN_CONTEXT_RESOLVER_VERSION } = await import(
    "@/lib/creative-decision-engine/campaign-context/resolver"
  );
  writeProviderDouble(matrixRoot);
  const doublePath = path.join(matrixRoot, "meta-provider-double.mjs");
  const script = path.join("scripts", "meta-decision-card-apply-harness.ts");
  const results: Array<Record<string, unknown>> = [];

  try {
    /*
      The template is seeded in a CHILD, not here. `CREATE DATABASE ... TEMPLATE`
      refuses while any session is connected to the template, and a pool opened
      in this process would hold one open for the rest of the run.
    */
    log("seeding the matrix template (no snapshot — each cell runs its own)...");
    await runChild(
      ["--import", "tsx", script, "--matrix-seed"],
      cluster.databaseUrl,
      "matrix-seed",
      {
        MATRIX_AS_OF: asOf,
        CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      },
    );

    /*
      `--only=<substring>` narrows the run while a cell is being debugged. It
      is a filter over the SAME generated list, never a different list, so a
      narrowed run and a full run always agree about what a cell is.
    */
    const only = process.env.MATRIX_ONLY?.trim() ?? "";
    const cells = matrixCells().filter(
      (posture) => !only || matrixCellId(posture).includes(only),
    );
    log(`${cells.length} cells; one cloned database and one process each.`);
    let index = 0;
    for (const posture of cells) {
      index += 1;
      const id = matrixCellId(posture);
      const cellDb = `matrix_cell_${String(index).padStart(2, "0")}`;
      runSync(
        path.join(pgBinDir, "createdb"),
        [
          "-h", "127.0.0.1",
          "-p", String(cluster.port),
          "-U", DB_USER,
          "-T", DB_NAME,
          cellDb,
        ],
        `createdb ${cellDb}`,
      );
      const cellUrl =
        `postgresql://${DB_USER}@127.0.0.1:${cluster.port}/${cellDb}`;
      const outFile = path.join(matrixRoot, `cell-${cellDb}.json`);
      log(`cell ${index}/${cells.length}  ${id}`);
      await runChild(
        ["--import", "tsx", "--import", doublePath, script, "--matrix-cell"],
        cellUrl,
        `matrix-cell ${id}`,
        {
          PGDATABASE: cellDb,
          MATRIX_CELL: JSON.stringify(posture),
          MATRIX_OUT: outFile,
          MATRIX_AS_OF: asOf,
          META_AUTOMATION_LIVE_WRITES: posture.master ? "true" : "false",
          META_DECISION_WORKFLOW_UI: "true",
          META_LAUNCHPAD_EXECUTION: "true",
          CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
          META_DECISIONS_UPSTREAM_TRANSPORT: "in_process",
        },
      );
      results.push(
        JSON.parse(fs.readFileSync(outFile, "utf8")) as Record<string, unknown>,
      );
    }

    const summaryFile = path.join(matrixRoot, "availability-matrix.json");
    fs.writeFileSync(summaryFile, JSON.stringify(results, null, 2), "utf8");
    printAvailabilityMatrix(results, summaryFile);
    if (keep) {
      log(`matrix artifacts kept at ${matrixRoot}`);
    } else {
      const copy = path.join(
        os.tmpdir(),
        `adsecute-availability-matrix-${asOf}.json`,
      );
      fs.copyFileSync(summaryFile, copy);
      log(`matrix JSON copied to ${copy}`);
    }
  } finally {
    if (keep) {
      log(`cluster kept at ${matrixRoot} (${cluster.databaseUrl})`);
    } else {
      stopCluster(cluster.state, pgBinDir);
      fs.rmSync(matrixRoot, { recursive: true, force: true });
      log(`matrix cluster removed (${matrixRoot})`);
    }
  }
}

function printAvailabilityMatrix(
  results: Array<Record<string, unknown>>,
  summaryFile: string,
) {
  console.log("");
  console.log("──────────────────── decision availability matrix ────────────────────");
  const factDigests = new Set(
    results.map((entry) => JSON.stringify(entry.factFingerprint)),
  );
  console.log(`  distinct warehouse fact fingerprints across all cells: ${factDigests.size}`);
  const decisionDigests = new Set(
    results.map((entry) => (entry.digests as { decision: string }).decision),
  );
  const retainedDigests = new Set(
    results.map((entry) => (entry.digests as { retained: string }).retained),
  );
  const ctaDigests = new Set(
    results.map((entry) => (entry.digests as { cta: string }).cta),
  );
  console.log(`  distinct SERVED decision fingerprints:                 ${decisionDigests.size}`);
  console.log(`  distinct RETAINED snapshot fingerprints:               ${retainedDigests.size}`);
  console.log(`  distinct CTA fingerprints:                             ${ctaDigests.size}`);
  console.log("");
  console.log(
    "  cell                                   | rows | concrete(amount) | hold | missing | state | queue | dispatch",
  );
  console.log(
    "  ---------------------------------------|------|------------------|------|---------|-------|-------|---------",
  );
  for (const entry of results) {
    const served = entry.served as { rows: MatrixServedRow[]; rowCount: number };
    const counts = matrixBucketCounts(served.rows);
    const amounts = served.rows
      .filter((row) => row.bucket === "concrete")
      .map((row) => row.appliedAmountMinor ?? "—")
      .join(",");
    const queue = entry.queue as { rows: string[]; pending: number };
    const dispatch = entry.dispatch as Record<string, unknown>;
    /*
      The refusal REASON, not the envelope's code.

      Both the STOP and the closed release capability answer with the same
      outer `kill_switch_engaged`, and printing that alone made two different
      postures look identical. The inner `reason` is what distinguishes them,
      so it is what the table shows.
    */
    const error = dispatch.errorCode as
      | { code?: string; reason?: string }
      | string
      | null;
    const errorLabel = !error
      ? "ok"
      : typeof error === "string"
        ? error
        : `${error.code ?? "error"}/${error.reason ?? "unstated"}`;
    const dispatchLabel = dispatch.attempted
      ? `${dispatch.httpStatus} ${errorLabel} dryRun=${dispatch.dryRun}`
      : String(dispatch.reason);
    console.log(
      `  ${String(entry.cell).padEnd(38)} | ${String(served.rowCount).padStart(4)} | `
      + `${String(`${counts.concrete} (${amounts || "—"})`).padEnd(16)} | `
      + `${String(counts.hold_or_watch).padStart(4)} | ${String(counts.missing_data).padStart(7)} | `
      + `${String(counts.state_only).padStart(5)} | ${String(queue.pending).padStart(5)} | ${dispatchLabel}`,
    );
  }
  console.log("");
  const anchorStatuses = new Set(
    results.map((entry) => {
      const anchor = (entry.served as { commercialAnchor?: unknown }).commercialAnchor as
        | { explanation?: { status?: string }; actions?: Array<{ action: string; eligible: boolean; blockerCode: string | null }> }
        | null;
      return JSON.stringify({
        status: anchor?.explanation?.status ?? null,
        actions: anchor?.actions?.map((a) => `${a.action}:${a.eligible ? "eligible" : a.blockerCode}`) ?? null,
      });
    }),
  );
  console.log("  served system.commercialAnchor, distinct values across all cells:");
  for (const value of anchorStatuses) console.log(`    ${value}`);
  console.log("");
  console.log("  serve-scope reproduction (same shipped reader, account vs no account):");
  const scopeShapes = new Set(
    results.map((entry) => JSON.stringify((entry as { serveScope?: unknown }).serveScope)),
  );
  const firstScope = (results[0] as { serveScope?: {
    withAccount: Array<Record<string, unknown>>;
    withoutAccount: Array<Record<string, unknown>>;
  } }).serveScope;
  console.log(`    distinct serve-scope observations across cells: ${scopeShapes.size}`);
  for (const row of firstScope?.withAccount ?? []) {
    console.log(`    with account    ${String(row.type).padEnd(26)} state=${row.decisionState} kind=${row.campaignKind} ctx=${row.campaignContextAuthority}`);
  }
  for (const row of firstScope?.withoutAccount ?? []) {
    console.log(`    without account ${String(row.type).padEnd(26)} state=${row.decisionState} kind=${row.campaignKind} ctx=${row.campaignContextAuthority}`);
  }
  console.log("");
  console.log("  missing-data codes actually observed (identical in every cell unless stated):");
  const codes = new Map<string, number>();
  for (const entry of results) {
    const served = entry.served as { rows: MatrixServedRow[] };
    for (const row of served.rows) {
      for (const code of [...row.missingDataBlockers, row.hardActionBlocker ?? ""]) {
        if (!code) continue;
        codes.set(code, (codes.get(code) ?? 0) + 1);
      }
    }
  }
  for (const [code, count] of [...codes.entries()].sort()) {
    console.log(`    ${code.padEnd(40)} ${count} row-observations across ${results.length} cells`);
  }
  console.log("");
  console.log(`  full JSON: ${summaryFile}`);
  console.log("──────────────────────────────────────────────────────────────────────");
}

/* --------------------------------------------------------------------- main */

async function main() {
  const args = new Set(process.argv.slice(2));
  const rootDir =
    process.env.DECISION_CARD_APPLY_HARNESS_ROOT?.trim() ||
    path.join(os.tmpdir(), "adsecute-decision-card-apply-harness");
  const pgBinDir = resolvePgBinDir();

  /*
   * The two re-entrant child modes of the availability matrix.
   *
   * They are branches of this same file rather than separate scripts because
   * they must seed and read EXACTLY the fixture the standing harness builds —
   * a second copy of the seeder would be a second fixture, and the matrix
   * would then be grading something no other mode ever runs.
   */
  if (args.has("--matrix-seed")) {
    await runMatrixSeed();
    return;
  }
  if (args.has("--matrix-cell")) {
    await runMatrixCell();
    return;
  }
  /*
    Re-print a finished matrix from its own JSON.

    Twenty-four cells is a few minutes of cluster time, and a report that can
    only be re-read by re-measuring is a report nobody re-reads.
  */
  const reportArg = [...args].find((arg) => arg.startsWith("--matrix-report="));
  if (reportArg) {
    const file = reportArg.slice("--matrix-report=".length);
    printAvailabilityMatrix(
      JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, unknown>>,
      file,
    );
    return;
  }
  if (args.has("--availability-matrix")) {
    await runAvailabilityMatrix(rootDir, pgBinDir, args.has("--keep"));
    return;
  }

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

  /*
   * `--rerun-probe` is the stability grader, not a second fixture.
   *
   * It builds its own cluster under a sibling directory so it can never
   * disturb a standing harness, seeds the identical facts WITHOUT the seed's
   * own snapshot run, and then drives `runMetaSnapshotForBusiness` itself:
   * twice on byte-identical warehouse rows and once more after a real fact
   * change. It removes the cluster when it is done unless `--keep` is passed.
   */
  if (args.has("--rerun-probe")) {
    const probeRoot = `${rootDir}-rerun-probe`;
    const previous = readState(probeRoot);
    if (previous) {
      stopCluster(previous, pgBinDir);
      fs.rmSync(probeRoot, { recursive: true, force: true });
    }
    const cluster = await bringUpCluster(probeRoot, pgBinDir);
    try {
      log("seeding (no snapshot run — the probe drives it)...");
      process.env.DATABASE_URL = cluster.databaseUrl;
      process.env.DATABASE_URL_UNPOOLED = cluster.databaseUrl;
      const probeAsOf = resolveAsOf();
      await seed(probeAsOf, { runSnapshot: false });
      await runProbe(probeAsOf);
    } finally {
      if (args.has("--keep")) {
        log(`cluster kept at ${probeRoot} (${cluster.databaseUrl})`);
      } else {
        stopCluster(cluster.state, pgBinDir);
        fs.rmSync(probeRoot, { recursive: true, force: true });
        log(`probe cluster removed (${probeRoot})`);
      }
    }
    return;
  }

  /*
   * `--clock-rerun-probe` is the OTHER stability grader.
   *
   * Same cluster discipline as `--rerun-probe` — its own sibling directory, its
   * own teardown — but it skips this file's fixture entirely and seeds a small
   * business of its own. It has to: the standing fixture's snapshot date is
   * always yesterday, and the family under test cannot be judged on a closed
   * day, so the loss it grades would be invisible in that fixture.
   */
  if (args.has("--clock-rerun-probe")) {
    const probeRoot = `${rootDir}-clock-rerun-probe`;
    const previous = readState(probeRoot);
    if (previous) {
      stopCluster(previous, pgBinDir);
      fs.rmSync(probeRoot, { recursive: true, force: true });
    }
    const cluster = await bringUpCluster(probeRoot, pgBinDir);
    try {
      process.env.DATABASE_URL = cluster.databaseUrl;
      process.env.DATABASE_URL_UNPOOLED = cluster.databaseUrl;
      await runClockRerunProbe();
    } finally {
      if (args.has("--keep")) {
        log(`cluster kept at ${probeRoot} (${cluster.databaseUrl})`);
      } else {
        stopCluster(cluster.state, pgBinDir);
        fs.rmSync(probeRoot, { recursive: true, force: true });
        log(`clock probe cluster removed (${probeRoot})`);
      }
    }
    return;
  }

  const existing = readState(rootDir);
  if (existing) {
    fail(
      `A harness cluster is already recorded at ${rootDir} (port ${existing.port}). ` +
        "Run with --stop first, or set DECISION_CARD_APPLY_HARNESS_ROOT to a different directory.",
    );
  }

  const { databaseUrl, dataDir } = await bringUpCluster(rootDir, pgBinDir);

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
