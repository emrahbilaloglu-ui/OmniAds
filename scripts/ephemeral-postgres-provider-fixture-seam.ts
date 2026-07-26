/**
 * P0-2 — deterministic provider fixtures for the ACTUAL production sync
 * entrypoints, against a real migrated PostgreSQL.
 *
 * The capacity-fence seam (ephemeral-postgres-growth-fence-entrypoint-seam.ts)
 * proves refusal happens before provider or durable work. On its own that is a
 * *vacuous* proof: an entrypoint that never does anything also never calls a
 * provider. This seam supplies the missing anchor — a real admitted run that
 * reaches the provider boundary and completes its normal durable success
 * transition — and then re-runs the negatives against that working path.
 *
 * Nothing is faked below the provider HTTP boundary: real migrations, real
 * `getDb`, real selection/connection/credential chain, real entrypoints. Only
 * `globalThis.fetch` is replaced, and it is replaced with a stub that FAILS the
 * seam if an unexpected host is contacted.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "provider_fixture_seam";
const USER = "postgres";
const LABEL = "[provider-fixture-seam]";
const GiB = 1024 ** 3;

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const GOOGLE_CUSTOMER_ID = "1234567890";
const UNSELECTED_GOOGLE_CUSTOMER_ID = "9876543210";
const META_ACCOUNT_ID = "act_100200300";
const META_WORKER_ID = "seam-meta-worker";
const SYNC_DATE = "2026-07-01";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pgBinDir() {
  const need = ["initdb", "pg_ctl", "createdb"];
  const linux = fs.existsSync("/usr/lib/postgresql")
    ? fs
        .readdirSync("/usr/lib/postgresql", { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join("/usr/lib/postgresql", entry.name, "bin"))
    : [];
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    ...linux,
    ...(process.env.PATH ?? "").split(path.delimiter),
  ].filter(Boolean) as string[];
  const found = candidates.find((dir) =>
    need.every((bin) => fs.existsSync(path.join(dir, bin))),
  );
  if (!found) throw new Error("PostgreSQL binaries not found.");
  return found;
}

async function freePort() {
  for (let i = 0; i < 10; i += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() =>
          address && typeof address === "object"
            ? resolve(address.port)
            : reject(new Error("no port")),
        );
      });
    });
    if (!FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("no safe port");
}

function run(bin: string, args: string[], label: string) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}). ${result.stderr?.trim() ?? ""}`);
  }
}

// ── Provider boundary stub ────────────────────────────────────────────────

interface ProviderCall {
  url: string;
  method: string;
  /** Request body, so a case can prove WHICH day was fetched, not just how many. */
  body: string;
  kind: "google_gaql" | "meta_graph" | "unexpected";
}

interface ProviderStub {
  calls: ProviderCall[];
  /** Calls that actually reached a provider API, i.e. forbidden after refusal. */
  providerCalls: () => ProviderCall[];
  /** Runs before each response is produced; lets a case mutate state mid-flight. */
  onCall: ((call: ProviderCall, index: number) => Promise<void> | void) | null;
  reset: () => void;
}

/**
 * One campaign row in the exact nested shape the Google Ads REST search
 * endpoint returns, so `buildCampaignMap` and the warehouse mappers run for
 * real rather than against a hand-shaped internal object.
 */
const GOOGLE_CAMPAIGN_RESULT = {
  campaign: {
    resourceName: `customers/${GOOGLE_CUSTOMER_ID}/campaigns/555000111`,
    id: "555000111",
    name: "Seam Brand Search",
    status: "ENABLED",
    advertisingChannelType: "SEARCH",
  },
  metrics: {
    impressions: "1200",
    clicks: "48",
    costMicros: "12500000",
    conversions: 6,
    conversionsValue: 480.5,
    interactions: "48",
    searchImpressionShare: 0.62,
    searchBudgetLostImpressionShare: 0.11,
    searchRankLostImpressionShare: 0.27,
  },
  campaignBudget: {
    resourceName: `customers/${GOOGLE_CUSTOMER_ID}/campaignBudgets/900001`,
    amountMicros: "20000000",
  },
  customer: {
    resourceName: `customers/${GOOGLE_CUSTOMER_ID}`,
    id: GOOGLE_CUSTOMER_ID,
    currencyCode: "TRY",
    timeZone: "Europe/Istanbul",
  },
};

/**
 * Mutable config payload, so a case can present state A, then B, then A again
 * and prove a genuine revert is preserved rather than collapsed.
 */
const metaConfigVariant = {
  campaignDailyBudget: "50000",
  adsetDailyBudget: "25000",
};

/**
 * Meta responses are routed by endpoint. The account profile in particular must
 * carry a currency: without it the core warehouse refuses the partition with
 * `meta_currency_unavailable`, which would make every Meta case fail for a
 * fixture reason rather than the behaviour under test.
 */
function metaGraphPayload(url: string): unknown {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  if (pathname.endsWith("/insights")) {
    const since =
      JSON.parse(parsed.searchParams.get("time_range") ?? "{}")?.since ?? SYNC_DATE;
    const level = parsed.searchParams.get("level") ?? "account";
    const base = {
      date_start: since,
      date_stop: since,
      account_id: META_ACCOUNT_ID.replace("act_", ""),
      account_currency: "TRY",
      spend: "125.50",
      impressions: "3400",
      clicks: "88",
      actions: [{ action_type: "purchase", value: "4" }],
      action_values: [{ action_type: "purchase", value: "612.75" }],
    };
    // Entity-level rows are what drive config snapshot/history construction —
    // an account-only response would leave those tables empty and make the
    // coalescing proofs vacuous.
    const entity =
      level === "ad"
        ? {
            campaign_id: "23851000000000001",
            campaign_name: "Seam Prospecting",
            adset_id: "23851000000000101",
            adset_name: "Seam Broad",
            ad_id: "23851000000000201",
            ad_name: "Seam Ad",
          }
        : level === "adset"
          ? {
              campaign_id: "23851000000000001",
              campaign_name: "Seam Prospecting",
              adset_id: "23851000000000101",
              adset_name: "Seam Broad",
            }
          : level === "campaign"
            ? {
                campaign_id: "23851000000000001",
                campaign_name: "Seam Prospecting",
              }
            : {};
    return { data: [{ ...base, ...entity }], paging: {} };
  }
  // Config inventory. These MUST return real rows: with an empty inventory the
  // "identical runs coalesce" proofs would pass vacuously (zero rows in, zero
  // rows out) and would say nothing about the config-history triggers.
  if (pathname.endsWith("/campaigns")) {
    return {
      data: [
        {
          id: "23851000000000001",
          name: "Seam Prospecting",
          objective: "OUTCOME_SALES",
          effective_status: "ACTIVE",
          status: "ACTIVE",
          updated_time: "2026-07-20T09:00:00+0000",
          buying_type: "AUCTION",
          daily_budget: metaConfigVariant.campaignDailyBudget,
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        },
      ],
      paging: {},
    };
  }
  if (pathname.endsWith("/adsets")) {
    return {
      data: [
        {
          id: "23851000000000101",
          name: "Seam Broad",
          campaign_id: "23851000000000001",
          effective_status: "ACTIVE",
          status: "ACTIVE",
          updated_time: "2026-07-20T09:00:00+0000",
          daily_budget: metaConfigVariant.adsetDailyBudget,
          optimization_goal: "OFFSITE_CONVERSIONS",
          promoted_object: {
            pixel_id: "998877665544332",
            custom_event_type: "PURCHASE",
          },
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        },
      ],
      paging: {},
    };
  }
  if (pathname.endsWith("/ads")) {
    return {
      data: [
        {
          id: "23851000000000201",
          name: "Seam Ad",
          campaign_id: "23851000000000001",
          adset_id: "23851000000000101",
          effective_status: "ACTIVE",
          status: "ACTIVE",
          updated_time: "2026-07-20T09:00:00+0000",
          created_time: "2026-07-01T09:00:00+0000",
          creative: { id: "23851000000000301" },
        },
      ],
      paging: {},
    };
  }
  // Account profile lookup: /act_<id>?fields=currency,name,timezone_name
  if (/\/act_\d+$/.test(pathname)) {
    return {
      id: META_ACCOUNT_ID,
      account_id: META_ACCOUNT_ID.replace("act_", ""),
      currency: "TRY",
      name: "Seam Meta Account",
      timezone_name: "Europe/Istanbul",
    };
  }
  return { data: [], paging: {} };
}

function classify(url: string): ProviderCall["kind"] {
  if (url.includes("googleads.googleapis.com")) return "google_gaql";
  if (url.includes("graph.facebook.com")) return "meta_graph";
  return "unexpected";
}

function installProviderStub(): ProviderStub {
  const stub: ProviderStub = {
    calls: [],
    providerCalls: () => stub.calls.filter((call) => call.kind !== "unexpected"),
    onCall: null,
    reset: () => {
      stub.calls = [];
      stub.onCall = null;
    },
  };

  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: unknown },
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: string })?.url ?? input);
    const call: ProviderCall = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      kind: classify(url),
    };
    const index = stub.calls.length;
    stub.calls.push(call);
    if (stub.onCall) await stub.onCall(call, index);

    if (call.kind === "google_gaql") {
      return new Response(JSON.stringify({ results: [GOOGLE_CAMPAIGN_RESULT] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (call.kind === "meta_graph") {
      return new Response(JSON.stringify(metaGraphPayload(url)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(
      `${LABEL} the run contacted an unexpected host: ${call.method} ${url}`,
    );
  }) as unknown as typeof globalThis.fetch;

  return stub;
}

/**
 * The GAQL result cache and the login-context memo live on globalThis, so a
 * second identical case would be served from memory and record zero provider
 * calls. Clearing them keeps every case an independent measurement.
 */
function clearGoogleProcessCaches() {
  const store = globalThis as typeof globalThis & {
    __omniadsGoogleAdsGaqlCache?: Map<string, unknown>;
    __omniadsGoogleAdsLoginContextSuccess?: Map<string, unknown>;
    __omniadsGoogleAdsLoginContextFailures?: Map<string, unknown>;
  };
  store.__omniadsGoogleAdsGaqlCache?.clear();
  store.__omniadsGoogleAdsLoginContextSuccess?.clear();
  store.__omniadsGoogleAdsLoginContextFailures?.clear();
}

// ── Fixture ───────────────────────────────────────────────────────────────

async function seed(client: Client) {
  const owner = await client.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash)
     VALUES ('seam','seam@provider-fixture.test','x') RETURNING id`,
  );
  await client.query(
    `INSERT INTO businesses (id, name, owner_id) VALUES ($1::uuid, 'Seam', $2::uuid)`,
    [BUSINESS_ID, owner.rows[0]!.id],
  );
  await client.query(
    `INSERT INTO businesses (id, name, owner_id) VALUES ($1::uuid, 'Other', $2::uuid)`,
    [OTHER_BUSINESS_ID, owner.rows[0]!.id],
  );

  const accounts = await client.query<{ id: string; external_account_id: string }>(
    `INSERT INTO provider_accounts
       (provider, external_account_id, account_name, currency, timezone, is_manager)
     VALUES ('google', $1, 'Seam Google Account', 'TRY', 'Europe/Istanbul', FALSE),
            ('google', $2, 'Unselected Account',  'TRY', 'Europe/Istanbul', FALSE)
     RETURNING id, external_account_id`,
    [GOOGLE_CUSTOMER_ID, UNSELECTED_GOOGLE_CUSTOMER_ID],
  );
  const refByExternal = new Map(
    accounts.rows.map((row) => [row.external_account_id, row.id]),
  );

  // Selected binding for the account under test; an explicitly UNSELECTED
  // binding for a second account, so "only selected accounts are synced" is
  // measured rather than assumed from an empty table.
  await client.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
     VALUES ($1, 'google', $2::uuid, $3, 0, TRUE),
            ($1, 'google', $4::uuid, $5, 1, FALSE)`,
    [
      BUSINESS_ID,
      refByExternal.get(GOOGLE_CUSTOMER_ID),
      GOOGLE_CUSTOMER_ID,
      refByExternal.get(UNSELECTED_GOOGLE_CUSTOMER_ID),
      UNSELECTED_GOOGLE_CUSTOMER_ID,
    ],
  );

  const connection = await client.query<{ id: string }>(
    `INSERT INTO provider_connections
       (business_id, provider, status, provider_account_id, provider_account_name, connected_at)
     VALUES ($1, 'google', 'connected', $2, 'Seam Google Account', now())
     RETURNING id`,
    [BUSINESS_ID, GOOGLE_CUSTOMER_ID],
  );
  await client.query(
    `INSERT INTO integration_credentials
       (provider_connection_id, access_token, refresh_token, token_expires_at, scopes)
     VALUES ($1::uuid, 'seam-google-access-token', 'seam-google-refresh-token',
             now() + interval '30 days', 'https://www.googleapis.com/auth/adwords')`,
    [connection.rows[0]!.id],
  );

  // ── Meta: the same authority chain, for consumeMetaQueuedWork and the
  // lifecycle-partition consumer.
  const metaAccount = await client.query<{ id: string }>(
    `INSERT INTO provider_accounts
       (provider, external_account_id, account_name, currency, timezone, is_manager)
     VALUES ('meta', $1, 'Seam Meta Account', 'TRY', 'Europe/Istanbul', FALSE)
     RETURNING id`,
    [META_ACCOUNT_ID],
  );
  await client.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
     VALUES ($1, 'meta', $2::uuid, $3, 0, TRUE)`,
    [BUSINESS_ID, metaAccount.rows[0]!.id, META_ACCOUNT_ID],
  );
  const metaConnection = await client.query<{ id: string }>(
    `INSERT INTO provider_connections
       (business_id, provider, status, provider_account_id, provider_account_name, connected_at)
     VALUES ($1, 'meta', 'connected', $2, 'Seam Meta Account', now())
     RETURNING id`,
    [BUSINESS_ID, META_ACCOUNT_ID],
  );
  await client.query(
    `INSERT INTO integration_credentials
       (provider_connection_id, access_token, refresh_token, token_expires_at, scopes)
     VALUES ($1::uuid, 'seam-meta-access-token', NULL,
             now() + interval '30 days', 'ads_read')`,
    [metaConnection.rows[0]!.id],
  );
}

interface DurableCounts {
  jobsTotal: number;
  jobsSucceeded: number;
  jobsFailed: number;
  dailyRows: number;
  rawSnapshots: number;
}

async function readGoogleDurable(client: Client): Promise<DurableCounts> {
  const row = await client.query<Record<string, string>>(`
    SELECT
      (SELECT COUNT(*)::text FROM google_ads_sync_jobs) AS jobs_total,
      (SELECT COUNT(*)::text FROM google_ads_sync_jobs WHERE status = 'succeeded') AS jobs_succeeded,
      (SELECT COUNT(*)::text FROM google_ads_sync_jobs WHERE status = 'failed') AS jobs_failed,
      (SELECT COUNT(*)::text FROM google_ads_campaign_daily) AS daily_rows,
      (SELECT COUNT(*)::text FROM google_ads_raw_snapshots) AS raw_snapshots
  `);
  const values = row.rows[0]!;
  return {
    jobsTotal: Number(values.jobs_total),
    jobsSucceeded: Number(values.jobs_succeeded),
    jobsFailed: Number(values.jobs_failed),
    dailyRows: Number(values.daily_rows),
    rawSnapshots: Number(values.raw_snapshots),
  };
}

// ── Cases ─────────────────────────────────────────────────────────────────

const UNDER_BUDGET = {
  SYNC_GROWTH_FENCE_DATABASE_BYTES: String(1024 ** 4),
  SYNC_GROWTH_FENCE_META_ENTITY_STATE_HISTORY_BYTES: String(500 * GiB),
  SYNC_GROWTH_FENCE_META_CREATIVE_LINEAGE_EDGES_BYTES: String(500 * GiB),
  SYNC_GROWTH_FENCE_SYNC_RELEASE_GATES_BYTES: String(500 * GiB),
};
const OVER_BUDGET = { SYNC_GROWTH_FENCE_DATABASE_BYTES: "1" };

async function verifyGoogle(client: Client) {
  const google = await import("@/lib/sync/google-ads-sync");
  const fence = await import("@/lib/sync/db-growth-fence");
  const stub = installProviderStub();

  const withEnv = async <T>(
    overrides: Record<string, string>,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(overrides)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    fence.resetDbGrowthFenceCache();
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      fence.resetDbGrowthFenceCache();
    }
  };

  const runRange = (input?: { startDate?: string; endDate?: string }) =>
    google.syncGoogleAdsRange({
      businessId: BUSINESS_ID,
      startDate: input?.startDate ?? SYNC_DATE,
      endDate: input?.endDate ?? SYNC_DATE,
      syncType: "incremental_recent",
      triggerSource: "provider_fixture_seam",
      scopes: ["campaign_daily"],
    });

  const freshCase = () => {
    stub.reset();
    clearGoogleProcessCaches();
  };

  // ── G1. Admitted run reaches the provider and completes durable success.
  freshCase();
  const before = await readGoogleDurable(client);
  const admitted = await withEnv(UNDER_BUDGET, runRange);
  const afterAdmitted = await readGoogleDurable(client);

  assert(
    stub.providerCalls().length > 0,
    `G1: an admitted run made ${stub.providerCalls().length} provider calls; the success path is not actually reached.`,
  );
  assert(
    stub.calls.every((call) => call.kind === "google_gaql"),
    `G1: the run contacted a non-Google host: ${JSON.stringify(stub.calls.filter((c) => c.kind !== "google_gaql"))}`,
  );
  assert(
    (admitted as { succeeded?: number }).succeeded === 1,
    `G1: expected exactly one succeeded account-day, got ${JSON.stringify(admitted)}`,
  );
  assert(
    afterAdmitted.jobsSucceeded > before.jobsSucceeded,
    `G1: no google_ads_sync_jobs row reached 'succeeded' (${before.jobsSucceeded} -> ${afterAdmitted.jobsSucceeded}).`,
  );
  assert(
    afterAdmitted.jobsFailed === before.jobsFailed,
    "G1: the admitted run recorded a failed job.",
  );
  assert(
    afterAdmitted.dailyRows > before.dailyRows,
    `G1: no warehouse rows persisted (${before.dailyRows} -> ${afterAdmitted.dailyRows}).`,
  );
  assert(
    afterAdmitted.rawSnapshots > before.rawSnapshots,
    `G1: no raw snapshot persisted (${before.rawSnapshots} -> ${afterAdmitted.rawSnapshots}).`,
  );

  // Read the durable transition back by identity, not just by count.
  const successRow = await client.query<{
    status: string;
    progress_percent: string;
    finished_at: string | null;
    provider_account_id: string;
    scope: string;
  }>(
    `SELECT status, progress_percent::text, finished_at, provider_account_id, scope
     FROM google_ads_sync_jobs
     WHERE business_id = $1 AND status = 'succeeded'
     ORDER BY triggered_at DESC LIMIT 1`,
    [BUSINESS_ID],
  );
  assert(successRow.rowCount === 1, "G1: success job row not readable back.");
  assert(
    successRow.rows[0]!.provider_account_id === GOOGLE_CUSTOMER_ID &&
      successRow.rows[0]!.scope === "campaign_daily" &&
      Number(successRow.rows[0]!.progress_percent) === 100 &&
      successRow.rows[0]!.finished_at != null,
    `G1: success row is not the normal completion shape: ${JSON.stringify(successRow.rows[0])}`,
  );
  const warehouseRow = await client.query<{
    provider_account_id: string;
    date: string;
    entity_key: string;
    spend: string;
    source_snapshot_id: string | null;
  }>(
    `SELECT provider_account_id, date::text AS date, entity_key, spend::text AS spend,
            source_snapshot_id::text AS source_snapshot_id
     FROM google_ads_campaign_daily
     WHERE business_id = $1
     LIMIT 1`,
    [BUSINESS_ID],
  );
  assert(
    warehouseRow.rowCount === 1 &&
      warehouseRow.rows[0]!.provider_account_id === GOOGLE_CUSTOMER_ID &&
      warehouseRow.rows[0]!.date === SYNC_DATE &&
      warehouseRow.rows[0]!.entity_key === "555000111" &&
      // 12_500_000 micros from the fixture response.
      Number(warehouseRow.rows[0]!.spend) === 12.5 &&
      warehouseRow.rows[0]!.source_snapshot_id != null,
    `G1: warehouse row is not the fixture's account/day/campaign: ${JSON.stringify(warehouseRow.rows)}`,
  );
  console.log(
    `${LABEL} G1 PASS admitted syncGoogleAdsRange: ${stub.providerCalls().length} provider calls, job succeeded, warehouse + raw snapshot persisted and read back`,
  );

  // Every negative below is measured against G1's baseline, so "zero provider
  // calls" cannot pass merely because the path is broken.
  const baseline = await readGoogleDurable(client);

  const setSelected = (selected: boolean, externalId = GOOGLE_CUSTOMER_ID) =>
    client.query(
      `UPDATE business_provider_accounts SET is_selected = $3, updated_at = now()
       WHERE business_id = $1 AND provider = 'google' AND provider_account_id = $2`,
      [BUSINESS_ID, externalId, selected],
    );
  const setConnectionStatus = (status: string) =>
    client.query(
      `UPDATE provider_connections SET status = $2, updated_at = now()
       WHERE business_id = $1 AND provider = 'google'`,
      [BUSINESS_ID, status],
    );

  const expectNoProviderWork = async (label: string, note: string) => {
    assert(
      stub.providerCalls().length === 0,
      `${label}: ${stub.providerCalls().length} provider calls — ${note}`,
    );
    const after = await readGoogleDurable(client);
    assert(
      JSON.stringify(after) === JSON.stringify(baseline),
      `${label}: durable state changed.\n  baseline ${JSON.stringify(baseline)}\n  after    ${JSON.stringify(after)}`,
    );
  };

  // ── G2. Deselected binding: the row still exists, is_selected is FALSE.
  freshCase();
  await setSelected(false);
  const deselected = await withEnv(UNDER_BUDGET, () =>
    runRange({ startDate: "2026-07-02", endDate: "2026-07-02" }),
  );
  assert(
    (deselected as { skipped?: boolean }).skipped === true &&
      (deselected as { attempted?: number }).attempted === 0,
    `G2: a deselected account did not report zero attempted work: ${JSON.stringify(deselected)}`,
  );
  await expectNoProviderWork("G2", "a deselected account was still synced");
  await setSelected(true);
  console.log(`${LABEL} G2 PASS deselected binding: zero provider calls, zero durable writes`);

  // ── G3. Wrong binding: the selection belongs to another business.
  freshCase();
  const otherAccounts = await client.query<{ id: string }>(
    `SELECT id FROM provider_accounts WHERE external_account_id = $1`,
    [UNSELECTED_GOOGLE_CUSTOMER_ID],
  );
  await client.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
     VALUES ($1, 'google', $2::uuid, $3, 0, TRUE)`,
    [OTHER_BUSINESS_ID, otherAccounts.rows[0]!.id, UNSELECTED_GOOGLE_CUSTOMER_ID],
  );
  const crossTenant = await withEnv(UNDER_BUDGET, () =>
    google.syncGoogleAdsRange({
      businessId: OTHER_BUSINESS_ID,
      startDate: "2026-07-02",
      endDate: "2026-07-02",
      syncType: "incremental_recent",
      triggerSource: "provider_fixture_seam",
      scopes: ["campaign_daily"],
    }),
  );
  assert(
    (crossTenant as { skipped?: boolean }).skipped === true,
    `G3: a business with a selected binding but no connected integration still ran: ${JSON.stringify(crossTenant)}`,
  );
  await expectNoProviderWork(
    "G3",
    "a selected binding without a connected provider connection authorised a sync",
  );
  console.log(
    `${LABEL} G3 PASS wrong binding: selection alone does not authorise provider work without a connected integration`,
  );

  // ── G4. Disconnected integration for the correct, still-selected binding.
  freshCase();
  await setConnectionStatus("disconnected");
  const disconnected = await withEnv(UNDER_BUDGET, () =>
    runRange({ startDate: "2026-07-02", endDate: "2026-07-02" }),
  );
  assert(
    (disconnected as { skipped?: boolean }).skipped === true,
    `G4: a disconnected integration still ran: ${JSON.stringify(disconnected)}`,
  );
  await expectNoProviderWork("G4", "a disconnected integration was still synced");
  await setConnectionStatus("connected");
  console.log(`${LABEL} G4 PASS disconnected integration: zero provider calls`);

  // ── G5. Capacity refusal on the proven-working path.
  freshCase();
  const refusal = await withEnv(OVER_BUDGET, () =>
    runRange({ startDate: "2026-07-02", endDate: "2026-07-02" }).then(
      (value) => ({ kind: "resolved" as const, value }),
      (error) => ({ kind: "rejected" as const, error }),
    ),
  );
  assert(
    refusal.kind === "rejected" && refusal.error instanceof fence.DbGrowthFenceRefusal,
    `G5: capacity refusal did not throw a fence refusal: ${JSON.stringify(refusal)}`,
  );
  await expectNoProviderWork("G5", "a refused run reached the provider");
  console.log(
    `${LABEL} G5 PASS capacity refusal on a path proven to work: zero provider calls, zero durable writes`,
  );

  // ── G6. Mid-batch deselection. The batch resolves its account list once, so
  // this proves the per-account-day revalidation actually stops in-flight work.
  // `incremental_recent` enumerates recent-first, so 07-06 is the in-flight day
  // and 07-05/04/03 are the ones that must never be fetched.
  const IN_FLIGHT_DAY = "2026-07-06";
  const REVOKED_DAYS = ["2026-07-05", "2026-07-04", "2026-07-03"];
  freshCase();
  let midBatchDeselected = false;
  stub.onCall = async () => {
    if (midBatchDeselected) return;
    midBatchDeselected = true;
    await setSelected(false);
  };
  const midBatch = await withEnv(UNDER_BUDGET, () =>
    runRange({ startDate: "2026-07-03", endDate: "2026-07-06" }),
  );
  stub.onCall = null;
  await setSelected(true);
  const afterMidBatch = await readGoogleDurable(client);
  assert(
    (midBatch as { succeeded?: number }).succeeded === 1,
    `G6: expected exactly the in-flight day to finish, got ${JSON.stringify(midBatch)}`,
  );
  assert(
    afterMidBatch.jobsSucceeded === baseline.jobsSucceeded + 1,
    `G6: ${afterMidBatch.jobsSucceeded - baseline.jobsSucceeded} days completed after the selection was revoked; only the in-flight one may.`,
  );
  assert(
    afterMidBatch.jobsFailed === baseline.jobsFailed,
    "G6: revocation was recorded as a failure rather than a skip.",
  );
  // Falsifiable per-day evidence: the GAQL body carries the segments.date
  // window, so a call for a post-revocation day would be visible here.
  const leakedDays = REVOKED_DAYS.filter((day) =>
    stub.providerCalls().some((call) => call.body.includes(day)),
  );
  assert(
    leakedDays.length === 0,
    `G6: provider calls were made for days after the selection was revoked: ${leakedDays.join(", ")}`,
  );
  assert(
    stub.providerCalls().some((call) => call.body.includes(IN_FLIGHT_DAY)),
    "G6: the in-flight day made no provider call, so the revocation proof is vacuous.",
  );
  console.log(
    `${LABEL} G6 PASS mid-batch deselection: the in-flight day (${IN_FLIGHT_DAY}) completes, ${REVOKED_DAYS.join("/")} make no provider call and write no job`,
  );

  // Re-baseline: G6 legitimately advanced durable state by one day.
  const postMidBatch = await readGoogleDurable(client);

  // ── G7. Retry revalidation. A retried unit must re-check authority rather
  // than trusting the decision taken when the batch started.
  freshCase();
  await setSelected(false);
  const retry = await withEnv(UNDER_BUDGET, () =>
    runRange({ startDate: IN_FLIGHT_DAY, endDate: IN_FLIGHT_DAY }),
  );
  assert(
    (retry as { skipped?: boolean }).skipped === true,
    `G7: a retry of an already-synced day ignored the revoked selection: ${JSON.stringify(retry)}`,
  );
  assert(
    stub.providerCalls().length === 0,
    `G7: a retried unit made ${stub.providerCalls().length} provider calls after revocation.`,
  );
  const afterRetry = await readGoogleDurable(client);
  assert(
    JSON.stringify(afterRetry) === JSON.stringify(postMidBatch),
    `G7: a revoked retry changed durable state.\n  before ${JSON.stringify(postMidBatch)}\n  after  ${JSON.stringify(afterRetry)}`,
  );
  await setSelected(true);
  console.log(`${LABEL} G7 PASS retry revalidation: a revoked retry is refused at the unit boundary`);

  // ── G8. Competing workers on the same account-day must not duplicate
  // provider work or produce two success receipts for one unit.
  freshCase();
  const competing = await withEnv(UNDER_BUDGET, () =>
    Promise.allSettled([
      runRange({ startDate: "2026-07-10", endDate: "2026-07-10" }),
      runRange({ startDate: "2026-07-10", endDate: "2026-07-10" }),
    ]),
  );
  assert(
    competing.every((result) => result.status === "fulfilled"),
    `G8: a competing worker crashed: ${JSON.stringify(competing)}`,
  );
  const competingJobs = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM google_ads_sync_jobs
     WHERE business_id = $1 AND start_date = DATE '2026-07-10' AND status = 'succeeded'`,
    [BUSINESS_ID],
  );
  assert(
    Number(competingJobs.rows[0]!.count) === 1,
    `G8: ${competingJobs.rows[0]!.count} success receipts for one account-day; competing workers duplicated durable work.`,
  );
  const competingWarehouse = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM google_ads_campaign_daily
     WHERE business_id = $1 AND date = DATE '2026-07-10'`,
    [BUSINESS_ID],
  );
  assert(
    Number(competingWarehouse.rows[0]!.count) === 1,
    `G8: competing workers wrote ${competingWarehouse.rows[0]!.count} warehouse rows for one account-day.`,
  );
  // The loser must not leave a stuck non-terminal job either, or the queue
  // would look permanently busy for a unit nobody is working on.
  const competingStuck = await client.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM google_ads_sync_jobs
     WHERE business_id = $1 AND start_date = DATE '2026-07-10'
     GROUP BY status ORDER BY status`,
    [BUSINESS_ID],
  );
  assert(
    competingStuck.rows.every(
      (row) => row.status === "succeeded" || row.status === "cancelled",
    ),
    `G8: a contested account-day left non-terminal job rows: ${JSON.stringify(competingStuck.rows)}`,
  );
  console.log(
    `${LABEL} G8 PASS competing workers: one success receipt, one warehouse row, no stuck job for a contested account-day (${JSON.stringify(
      competingStuck.rows,
    )})`,
  );

  return { fence, stub, withEnv, freshCase };
}

interface MetaDurable {
  partitionsTotal: number;
  partitionsCompleted: number;
  partitionsQueued: number;
  partitionsLeased: number;
  jobsSucceeded: number;
  rawSnapshots: number;
  rawReceipts: number;
  rawObservations: number;
}

async function readMetaDurable(client: Client): Promise<MetaDurable> {
  // The observation relation arrives with Cluster C. Until then a raw snapshot
  // IS its own single observation, which keeps these counters meaningful on
  // both schemas. PostgreSQL parses every branch of a CASE, so the relation has
  // to be kept out of the statement entirely rather than guarded at runtime.
  const hasReceipts = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.meta_raw_snapshot_observations') IS NOT NULL AS present`,
  );
  const receiptCounters = hasReceipts.rows[0]?.present
    ? `(SELECT COUNT(*)::text FROM meta_raw_snapshot_observations) AS raw_receipts,
       (SELECT COALESCE(SUM(observation_count), 0)::text
        FROM meta_raw_snapshot_observations) AS raw_observations`
    : `(SELECT COUNT(*)::text FROM meta_raw_snapshots) AS raw_receipts,
       (SELECT COUNT(*)::text FROM meta_raw_snapshots) AS raw_observations`;
  const row = await client.query<Record<string, string>>(`
    SELECT
      (SELECT COUNT(*)::text FROM meta_sync_partitions) AS partitions_total,
      (SELECT COUNT(*)::text FROM meta_sync_partitions WHERE status = 'succeeded') AS partitions_completed,
      (SELECT COUNT(*)::text FROM meta_sync_partitions WHERE status = 'queued') AS partitions_queued,
      (SELECT COUNT(*)::text FROM meta_sync_partitions WHERE lease_owner IS NOT NULL) AS partitions_leased,
      (SELECT COUNT(*)::text FROM meta_sync_jobs WHERE status = 'success') AS jobs_succeeded,
      (SELECT COUNT(*)::text FROM meta_raw_snapshots) AS raw_snapshots,
${receiptCounters}
  `);
  const values = row.rows[0]!;
  return {
    partitionsTotal: Number(values.partitions_total),
    partitionsCompleted: Number(values.partitions_completed),
    partitionsQueued: Number(values.partitions_queued),
    partitionsLeased: Number(values.partitions_leased),
    jobsSucceeded: Number(values.jobs_succeeded),
    rawSnapshots: Number(values.raw_snapshots),
    rawReceipts: Number(values.raw_receipts),
    rawObservations: Number(values.raw_observations),
  };
}

async function verifyMeta(
  client: Client,
  shared: Awaited<ReturnType<typeof verifyGoogle>>,
) {
  const { stub, withEnv, freshCase } = shared;
  const meta = await import("@/lib/sync/meta-sync");
  const { acquireSyncRunnerLease } = await import("@/lib/sync/worker-health");

  // Partition leasing requires an active runner lease held by this worker —
  // the same authority the real worker takes. Acquired through the production
  // function so the fixture cannot drift from it.
  process.env.META_WORKER_ID = META_WORKER_ID;
  const leaseHeld = await acquireSyncRunnerLease({
    businessId: BUSINESS_ID,
    providerScope: "meta",
    leaseOwner: META_WORKER_ID,
    leaseMinutes: 30,
  });
  assert(leaseHeld, "M0: could not acquire the meta runner lease for the fixture worker.");

  const setMetaSelected = (selected: boolean) =>
    client.query(
      `UPDATE business_provider_accounts SET is_selected = $3, updated_at = now()
       WHERE business_id = $1 AND provider = 'meta' AND provider_account_id = $2`,
      [BUSINESS_ID, META_ACCOUNT_ID, selected],
    );
  const setMetaConnection = (status: string) =>
    client.query(
      `UPDATE provider_connections SET status = $2, updated_at = now()
       WHERE business_id = $1 AND provider = 'meta'`,
      [BUSINESS_ID, status],
    );
  // The account context is memoised on the shared server cache, so a case that
  // flips selection must drop the memo or it would measure stale authority
  // instead of behaviour. The unit-boundary check under test is deliberately
  // uncached and is NOT affected by this.
  const clearMetaContextCache = () => {
    const store = globalThis as typeof globalThis & {
      __omniadsServerCache?: { entries: Map<string, unknown>; inflight: Map<string, unknown> };
    };
    store.__omniadsServerCache?.entries.clear();
    store.__omniadsServerCache?.inflight.clear();
  };

  // ── M1. Admitted consume reaches the provider and completes a real partition.
  freshCase();
  const before = await readMetaDurable(client);
  const admitted = (await withEnv(UNDER_BUDGET, () =>
    meta.consumeMetaQueuedWork(BUSINESS_ID),
  )) as { attempted?: number; succeeded?: number; skipped?: boolean };
  const after = await readMetaDurable(client);

  assert(
    stub.providerCalls().length > 0,
    `M1: an admitted consume made ${stub.providerCalls().length} provider calls.`,
  );
  assert(
    stub.calls.every((call) => call.kind === "meta_graph"),
    `M1: the consumer contacted a non-Meta host: ${JSON.stringify(stub.calls.filter((c) => c.kind !== "meta_graph"))}`,
  );
  assert(
    admitted.skipped !== true && (admitted.attempted ?? 0) > 0,
    `M1: the consumer did no work: ${JSON.stringify(admitted)}`,
  );
  assert(
    (admitted.succeeded ?? 0) > 0 && after.partitionsCompleted > before.partitionsCompleted,
    `M1: no partition reached 'succeeded' (${before.partitionsCompleted} -> ${after.partitionsCompleted}); result ${JSON.stringify(admitted)}`,
  );
  assert(
    after.rawSnapshots > before.rawSnapshots && after.rawReceipts > before.rawReceipts,
    `M1: no raw snapshot content or receipt persisted (${before.rawSnapshots} -> ${after.rawSnapshots}, receipts ${before.rawReceipts} -> ${after.rawReceipts}).`,
  );
  const succeededPartition = await client.query<{
    lane: string;
    scope: string;
    partition_date: string;
    lease_owner: string | null;
    finished_at: string | null;
  }>(
    `SELECT lane, scope, partition_date::text AS partition_date, lease_owner, finished_at
     FROM meta_sync_partitions
     WHERE business_id = $1 AND provider_account_id = $2 AND status = 'succeeded'
     ORDER BY partition_date DESC LIMIT 1`,
    [BUSINESS_ID, META_ACCOUNT_ID],
  );
  assert(
    succeededPartition.rowCount === 1 &&
      succeededPartition.rows[0]!.finished_at != null &&
      succeededPartition.rows[0]!.lease_owner == null,
    `M1: the succeeded partition is not in the normal completion shape: ${JSON.stringify(succeededPartition.rows)}`,
  );
  console.log(
    `${LABEL} M1 PASS admitted consumeMetaQueuedWork: ${stub.providerCalls().length} provider calls, partition ${succeededPartition.rows[0]!.scope}@${succeededPartition.rows[0]!.partition_date} succeeded, raw snapshots persisted and read back`,
  );

  // A partition that could not prove finalization must be recorded as failed
  // and retryable — never silently reported as a success.
  const unproven = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meta_sync_partitions
     WHERE status = 'succeeded' AND last_error IS NOT NULL`,
  );
  assert(
    Number(unproven.rows[0]!.count) === 0,
    "M1: a partition carries an error yet is marked succeeded.",
  );

  const metaBaseline = await readMetaDurable(client);
  const expectNoMetaProviderWork = async (label: string, note: string) => {
    assert(
      stub.providerCalls().length === 0,
      `${label}: ${stub.providerCalls().length} provider calls — ${note}`,
    );
    const now = await readMetaDurable(client);
    assert(
      now.partitionsCompleted === metaBaseline.partitionsCompleted &&
        now.jobsSucceeded === metaBaseline.jobsSucceeded &&
        now.rawSnapshots === metaBaseline.rawSnapshots,
      `${label}: durable work advanced.\n  baseline ${JSON.stringify(metaBaseline)}\n  after    ${JSON.stringify(now)}`,
    );
  };

  // ── M2. Deselected Meta binding.
  freshCase();
  await setMetaSelected(false);
  clearMetaContextCache();
  const metaDeselected = (await withEnv(UNDER_BUDGET, () =>
    meta.consumeMetaQueuedWork(BUSINESS_ID),
  )) as { skipped?: boolean; attempted?: number };
  assert(
    metaDeselected.skipped === true && (metaDeselected.attempted ?? 0) === 0,
    `M2: a deselected Meta account still produced work: ${JSON.stringify(metaDeselected)}`,
  );
  await expectNoMetaProviderWork("M2", "a deselected Meta account was still synced");
  await setMetaSelected(true);
  clearMetaContextCache();
  console.log(`${LABEL} M2 PASS deselected Meta binding: zero provider calls, zero durable progress`);

  // ── M3. Disconnected Meta integration.
  freshCase();
  await setMetaConnection("disconnected");
  clearMetaContextCache();
  const metaDisconnected = (await withEnv(UNDER_BUDGET, () =>
    meta.consumeMetaQueuedWork(BUSINESS_ID),
  )) as { skipped?: boolean };
  assert(
    metaDisconnected.skipped === true,
    `M3: a disconnected Meta integration still ran: ${JSON.stringify(metaDisconnected)}`,
  );
  await expectNoMetaProviderWork("M3", "a disconnected Meta integration was still synced");
  await setMetaConnection("connected");
  clearMetaContextCache();
  console.log(`${LABEL} M3 PASS disconnected Meta integration: zero provider calls`);

  // ── M4. Capacity refusal on the proven-working consume path, with the queue
  // and lease left recoverable.
  freshCase();
  const beforeRefusal = await client.query<{ snapshot: string }>(
    `SELECT COALESCE(json_agg(row_to_json(p) ORDER BY p.id)::text, '[]') AS snapshot
     FROM (SELECT id, status, lease_owner, lease_expires_at, attempt_count, next_retry_at
           FROM meta_sync_partitions) p`,
  );
  const metaRefusal = await withEnv(OVER_BUDGET, () =>
    meta.consumeMetaQueuedWork(BUSINESS_ID).then(
      (value) => ({ kind: "resolved" as const, value }),
      (error) => ({ kind: "rejected" as const, error }),
    ),
  );
  assert(
    metaRefusal.kind === "rejected" &&
      metaRefusal.error instanceof shared.fence.DbGrowthFenceRefusal,
    `M4: capacity refusal did not throw a fence refusal: ${JSON.stringify(metaRefusal)}`,
  );
  await expectNoMetaProviderWork("M4", "a refused consume reached the provider");
  const afterRefusal = await client.query<{ snapshot: string }>(
    `SELECT COALESCE(json_agg(row_to_json(p) ORDER BY p.id)::text, '[]') AS snapshot
     FROM (SELECT id, status, lease_owner, lease_expires_at, attempt_count, next_retry_at
           FROM meta_sync_partitions) p`,
  );
  assert(
    beforeRefusal.rows[0]!.snapshot === afterRefusal.rows[0]!.snapshot,
    "M4: a refused consume mutated partition queue/lease state; the claim is not byte-identical.",
  );
  console.log(
    `${LABEL} M4 PASS capacity refusal on the working consume path: zero provider calls, partition queue and leases byte-identical`,
  );

  // ── M5. Mid-batch revocation. Revoking during the first provider call must
  // stop the batch, cancel the account's partitions, and record no failure.
  freshCase();
  await client.query(
    `UPDATE meta_sync_partitions SET status = 'queued', lease_owner = NULL,
       lease_expires_at = NULL, next_retry_at = NULL, last_error = NULL,
       finished_at = NULL, attempt_count = 0, updated_at = now()
     WHERE business_id = $1`,
    [BUSINESS_ID],
  );
  let revoked = false;
  stub.onCall = async () => {
    if (revoked) return;
    revoked = true;
    await setMetaSelected(false);
    clearMetaContextCache();
  };
  await withEnv(UNDER_BUDGET, () => meta.consumeMetaQueuedWork(BUSINESS_ID));
  stub.onCall = null;
  const revokedPartitions = await client.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM meta_sync_partitions
     WHERE business_id = $1 AND provider_account_id = $2
     GROUP BY status ORDER BY status`,
    [BUSINESS_ID, META_ACCOUNT_ID],
  );
  const cancelledCount = Number(
    revokedPartitions.rows.find((row) => row.status === "cancelled")?.count ?? 0,
  );
  assert(
    cancelledCount > 0,
    `M5: revocation left no cancelled partition; work would keep retrying against a revoked account: ${JSON.stringify(revokedPartitions.rows)}`,
  );
  assert(
    !revokedPartitions.rows.some((row) => row.status === "leased" || row.status === "running"),
    `M5: a partition is stuck leased/running after revocation: ${JSON.stringify(revokedPartitions.rows)}`,
  );
  const revokedError = await client.query<{ last_error: string | null }>(
    `SELECT DISTINCT last_error FROM meta_sync_partitions
     WHERE business_id = $1 AND status = 'cancelled'`,
    [BUSINESS_ID],
  );
  assert(
    revokedError.rows.every((row) => row.last_error === "meta_account_selection_revoked"),
    `M5: cancellation is not attributed to revocation: ${JSON.stringify(revokedError.rows)}`,
  );
  // The batch must have STOPPED, not merely cancelled after processing every
  // partition. The consumer used to ignore stopBatch entirely and ran the whole
  // leased set, so a revoked account still saw every remaining partition
  // attempt. Provider calls after the revocation instant are the observable
  // signal: exactly one call may be in flight when the revocation lands.
  const revocationCalls = stub.providerCalls().length;
  assert(
    revocationCalls <= 2,
    `M5: the batch kept going after revocation — ${revocationCalls} provider calls, so stopBatch was ignored.`,
  );
  await setMetaSelected(true);
  clearMetaContextCache();
  console.log(
    `${LABEL} M5 PASS mid-batch revocation: ${cancelledCount} partitions cancelled as revoked, the batch stopped after ${revocationCalls} provider calls rather than draining the leased set, none stuck leased, no false failure`,
  );

  // ── M6. Retry revalidation: re-processing a leased partition for a revoked
  // account must refuse at the unit boundary, not trust the batch decision.
  freshCase();
  await setMetaSelected(false);
  clearMetaContextCache();
  const retryPartition = await client.query<{ id: string; scope: string; lane: string; partition_date: string }>(
    `UPDATE meta_sync_partitions
     SET status = 'leased', lease_owner = $3, lease_expires_at = now() + interval '5 minutes',
         last_error = NULL, finished_at = NULL, updated_at = now()
     WHERE business_id = $1 AND provider_account_id = $2
     AND id = (SELECT id FROM meta_sync_partitions WHERE business_id = $1 LIMIT 1)
     RETURNING id::text AS id, scope, lane, partition_date::text AS partition_date`,
    [BUSINESS_ID, META_ACCOUNT_ID, META_WORKER_ID],
  );
  assert(retryPartition.rowCount === 1, "M6: could not stage a leased partition for the retry case.");
  const retryRow = retryPartition.rows[0]!;
  const retryOk = await withEnv(UNDER_BUDGET, () =>
    meta.processMetaLifecyclePartition({
      partition: {
        id: retryRow.id,
        businessId: BUSINESS_ID,
        providerAccountId: META_ACCOUNT_ID,
        lane: retryRow.lane,
        scope: retryRow.scope,
        partitionDate: retryRow.partition_date,
        attemptCount: 1,
        leaseEpoch: 0,
        source: "provider_fixture_seam",
      },
      workerId: META_WORKER_ID,
    } as never),
  );
  assert(
    stub.providerCalls().length === 0,
    `M6: a retried partition made ${stub.providerCalls().length} provider calls after revocation.`,
  );
  assert(
    retryOk === true,
    "M6: a revoked retry was reported as a processing failure rather than a loss of authority.",
  );
  const retryState = await client.query<{ status: string; last_error: string | null }>(
    `SELECT status, last_error FROM meta_sync_partitions WHERE id = $1::uuid`,
    [retryRow.id],
  );
  assert(
    retryState.rows[0]!.status === "cancelled" &&
      retryState.rows[0]!.last_error === "meta_account_selection_revoked",
    `M6: the retried partition was not cancelled as revoked: ${JSON.stringify(retryState.rows)}`,
  );
  await setMetaSelected(true);
  clearMetaContextCache();
  console.log(
    `${LABEL} M6 PASS retry revalidation: a revoked partition retry makes zero provider calls and is cancelled, not failed`,
  );

  // ── M7. A competing worker without the runner lease cannot lease or process
  // anything, so two consumers never duplicate provider work.
  freshCase();
  await client.query(
    `UPDATE meta_sync_partitions SET status = 'queued', lease_owner = NULL,
       lease_expires_at = NULL, next_retry_at = NULL, last_error = NULL,
       finished_at = NULL, attempt_count = 0, updated_at = now()
     WHERE business_id = $1`,
    [BUSINESS_ID],
  );
  const competingBefore = await readMetaDurable(client);
  process.env.META_WORKER_ID = "seam-meta-worker-competitor";
  const competitor = (await withEnv(UNDER_BUDGET, () =>
    meta.consumeMetaQueuedWork(BUSINESS_ID),
  )) as { attempted?: number; succeeded?: number };
  process.env.META_WORKER_ID = META_WORKER_ID;
  const competingAfter = await readMetaDurable(client);
  assert(
    (competitor.attempted ?? 0) === 0,
    `M7: a worker without the runner lease still leased and processed ${competitor.attempted} partitions.`,
  );
  assert(
    competingAfter.partitionsCompleted === competingBefore.partitionsCompleted,
    "M7: a worker without the runner lease completed durable partition work.",
  );
  assert(
    competingAfter.partitionsLeased === 0,
    `M7: a worker without the runner lease left ${competingAfter.partitionsLeased} partitions leased.`,
  );
  console.log(
    `${LABEL} M7 PASS competing worker: a consumer without the runner lease leases nothing and completes no durable work`,
  );

  // ── M8. processMetaLifecyclePartition as its own admitted entrypoint. M6
  // proved it refuses; without this the refusal is unanchored.
  const stageLeasedPartition = async () => {
    const staged = await client.query<{
      id: string;
      lane: string;
      scope: string;
      partition_date: string;
      lease_epoch: string;
      source: string;
    }>(
      `UPDATE meta_sync_partitions
       SET status = 'leased', lease_owner = $3,
           lease_expires_at = now() + interval '5 minutes',
           last_error = NULL, finished_at = NULL, updated_at = now()
       WHERE id = (
         SELECT id FROM meta_sync_partitions
         WHERE business_id = $1 AND provider_account_id = $2
           AND lane = 'maintenance' AND status <> 'succeeded'
         ORDER BY partition_date DESC LIMIT 1
       )
       RETURNING id::text AS id, lane, scope, partition_date::text AS partition_date,
                 lease_epoch::text AS lease_epoch, source`,
      [BUSINESS_ID, META_ACCOUNT_ID, META_WORKER_ID],
    );
    assert(staged.rowCount === 1, "M8: could not stage a leased maintenance partition.");
    return staged.rows[0]!;
  };

  freshCase();
  // Re-open the partitions that M5's revocation legitimately cancelled.
  await client.query(
    `UPDATE meta_sync_partitions SET status = 'queued', lease_owner = NULL,
       lease_expires_at = NULL, next_retry_at = NULL, last_error = NULL,
       finished_at = NULL, attempt_count = 0, updated_at = now()
     WHERE business_id = $1 AND status = 'cancelled'`,
    [BUSINESS_ID],
  );
  const lifecycleRow = await stageLeasedPartition();
  const beforeLifecycle = await readMetaDurable(client);
  const lifecycleOk = await withEnv(UNDER_BUDGET, () =>
    meta.processMetaLifecyclePartition({
      partition: {
        id: lifecycleRow.id,
        businessId: BUSINESS_ID,
        providerAccountId: META_ACCOUNT_ID,
        lane: lifecycleRow.lane,
        scope: lifecycleRow.scope,
        partitionDate: lifecycleRow.partition_date,
        attemptCount: 0,
        leaseEpoch: Number(lifecycleRow.lease_epoch),
        source: lifecycleRow.source,
      },
      workerId: META_WORKER_ID,
    } as never),
  );
  const afterLifecycle = await readMetaDurable(client);
  const lifecycleState = await client.query<{ status: string; finished_at: string | null }>(
    `SELECT status, finished_at FROM meta_sync_partitions WHERE id = $1::uuid`,
    [lifecycleRow.id],
  );
  assert(
    stub.providerCalls().length > 0,
    `M8: an admitted lifecycle partition made ${stub.providerCalls().length} provider calls.`,
  );
  assert(
    lifecycleOk === true && lifecycleState.rows[0]!.status === "succeeded",
    `M8: the partition did not reach 'succeeded': ok=${lifecycleOk} state=${JSON.stringify(lifecycleState.rows)}`,
  );
  assert(
    lifecycleState.rows[0]!.finished_at != null,
    "M8: a succeeded partition has no finished_at.",
  );
  // Under the two-layer model a re-observation of identical content
  // legitimately adds NO canonical row — that is the amplification fix. The
  // invariant that still must hold is that the observation was RECORDED, so
  // this asserts on the receipt relation rather than on canonical growth.
  assert(
    afterLifecycle.rawObservations > beforeLifecycle.rawObservations,
    `M8: the observation was not recorded at all (observations ${beforeLifecycle.rawObservations} -> ${afterLifecycle.rawObservations}, receipts ${beforeLifecycle.rawReceipts} -> ${afterLifecycle.rawReceipts}, canonical ${beforeLifecycle.rawSnapshots} -> ${afterLifecycle.rawSnapshots}).`,
  );
  console.log(
    `${LABEL} M8 PASS admitted processMetaLifecyclePartition: ${stub.providerCalls().length} provider calls, partition ${lifecycleRow.scope}@${lifecycleRow.partition_date} succeeded and read back`,
  );

  // ── M9. Capacity refusal at that same entrypoint, on the proven path.
  freshCase();
  const refusalRow = await stageLeasedPartition();
  const beforeM9 = await client.query<{ snapshot: string }>(
    `SELECT row_to_json(p)::text AS snapshot FROM
       (SELECT status, lease_owner, lease_expires_at, attempt_count, finished_at
        FROM meta_sync_partitions WHERE id = $1::uuid) p`,
    [refusalRow.id],
  );
  const lifecycleRefusal = await withEnv(OVER_BUDGET, () =>
    meta
      .processMetaLifecyclePartition({
        partition: {
          id: refusalRow.id,
          businessId: BUSINESS_ID,
          providerAccountId: META_ACCOUNT_ID,
          lane: refusalRow.lane,
          scope: refusalRow.scope,
          partitionDate: refusalRow.partition_date,
          attemptCount: 0,
          leaseEpoch: Number(refusalRow.lease_epoch),
          source: refusalRow.source,
        },
        workerId: META_WORKER_ID,
      } as never)
      .then(
        (value) => ({ kind: "resolved" as const, value }),
        (error) => ({ kind: "rejected" as const, error }),
      ),
  );
  assert(
    lifecycleRefusal.kind === "rejected" &&
      lifecycleRefusal.error instanceof shared.fence.DbGrowthFenceRefusal,
    `M9: capacity refusal did not throw a fence refusal: ${JSON.stringify(lifecycleRefusal)}`,
  );
  assert(
    stub.providerCalls().length === 0,
    `M9: a refused lifecycle partition made ${stub.providerCalls().length} provider calls.`,
  );
  const afterM9 = await client.query<{ snapshot: string }>(
    `SELECT row_to_json(p)::text AS snapshot FROM
       (SELECT status, lease_owner, lease_expires_at, attempt_count, finished_at
        FROM meta_sync_partitions WHERE id = $1::uuid) p`,
    [refusalRow.id],
  );
  assert(
    beforeM9.rows[0]!.snapshot === afterM9.rows[0]!.snapshot,
    `M9: a refused lifecycle partition mutated its lease/claim.\n  before ${beforeM9.rows[0]!.snapshot}\n  after  ${afterM9.rows[0]!.snapshot}`,
  );
  console.log(
    `${LABEL} M9 PASS capacity refusal at processMetaLifecyclePartition: zero provider calls, lease and claim byte-identical and still recoverable`,
  );
}

// NOTE: config-amplification, two-layer storage and growth-fence cases arrive
// with their own clusters, alongside the code they exercise. This file proves
// the selection/authority contract and the provider boundary.

interface EvidenceCensus {
  configSnapshots: number;
  campaignConfigHistory: number;
  adsetConfigHistory: number;
  entityObservationRuns: number;
  entityStateHistory: number;
}

async function readEvidenceCensus(client: Client): Promise<EvidenceCensus> {
  const row = await client.query<Record<string, string>>(`
    SELECT
      (SELECT COUNT(*)::text FROM meta_config_snapshots) AS config_snapshots,
      (SELECT COUNT(*)::text FROM meta_campaign_config_history) AS campaign_config_history,
      (SELECT COUNT(*)::text FROM meta_adset_config_history) AS adset_config_history,
      (SELECT COUNT(*)::text FROM meta_entity_observation_runs) AS entity_observation_runs,
      (SELECT COUNT(*)::text FROM meta_entity_state_history) AS entity_state_history
  `);
  const values = row.rows[0]!;
  return {
    configSnapshots: Number(values.config_snapshots),
    campaignConfigHistory: Number(values.campaign_config_history),
    adsetConfigHistory: Number(values.adset_config_history),
    entityObservationRuns: Number(values.entity_observation_runs),
    entityStateHistory: Number(values.entity_state_history),
  };
}

/**
 * C1-C3 — the historical amplification, measured across a backfill wave rather
 * than a single day.
 *
 * A one-day test cannot distinguish "writes no current evidence" from "writes
 * one row instead of three": the defect only becomes visible as a wave. These
 * cases drive the REAL core sync entrypoint across many historical days and
 * assert EXACT row deltas — zero — on every current-evidence surface, then
 * prove the account's own today still records all of it.
 */
async function verifyHistoricalEvidenceAmplification(
  client: Client,
  stub: ProviderStub,
) {
  const { syncMetaAccountCoreWarehouseDay } = await import("@/lib/api/meta");
  const { getMetaAccountContext } = await import("@/lib/meta/account-context");
  const context = await getMetaAccountContext(BUSINESS_ID);
  assert(
    context?.connected && context.accessToken,
    "C1: no connected Meta context, so the amplification cases would be vacuous.",
  );
  const credentials = {
    businessId: BUSINESS_ID,
    accessToken: context.accessToken,
    accountIds: [META_ACCOUNT_ID],
    currency: "TRY",
    accountProfiles: {
      [META_ACCOUNT_ID]: {
        currency: "TRY",
        timezone: "Europe/Istanbul",
        name: "Seam Meta Account",
      },
    },
  };

  const HISTORICAL_DAYS = [
    "2026-05-01",
    "2026-05-02",
    "2026-05-03",
    "2026-05-04",
    "2026-05-05",
    "2026-05-06",
    "2026-05-07",
    "2026-05-08",
    "2026-05-09",
    "2026-05-10",
  ];

  // Reuse the runner-lease holder: the lease is exclusive per business and
  // provider scope, so a second worker id could never heartbeat.
  const HISTORICAL_WORKER_ID = META_WORKER_ID;
  // The partition lease heartbeat additionally requires a live runner lease for
  // this worker, exactly as the production consumer holds one.
  const { acquireSyncRunnerLease } = await import("@/lib/sync/worker-health");
  const runnerLease = await acquireSyncRunnerLease({
    businessId: BUSINESS_ID,
    providerScope: "meta",
    leaseOwner: HISTORICAL_WORKER_ID,
    leaseMinutes: 15,
  });
  assert(
    runnerLease,
    "C1: could not renew the meta runner lease for the amplification cases.",
  );
  const before = await readEvidenceCensus(client);
  const historicalErrors: string[] = [];
  stub.reset();
  for (const [index, day] of HISTORICAL_DAYS.entries()) {
    const partition = await client.query<{ id: string; lease_epoch: string }>(
      `INSERT INTO meta_sync_partitions
         (business_id, provider_account_id, lane, scope, partition_date, status,
          source, lease_owner, lease_expires_at)
       VALUES ($1, $2, 'core', 'account_daily', $3::date, 'leased', 'seam', $4,
               now() + interval '10 minutes')
       ON CONFLICT (business_id, provider_account_id, lane, scope, partition_date)
       DO UPDATE SET status = 'leased', lease_owner = EXCLUDED.lease_owner,
                     lease_expires_at = EXCLUDED.lease_expires_at,
                     updated_at = now()
       RETURNING id::text AS id, lease_epoch::text AS lease_epoch`,
      [BUSINESS_ID, META_ACCOUNT_ID, day, HISTORICAL_WORKER_ID],
    );
    await syncMetaAccountCoreWarehouseDay({
      credentials,
      accountId: META_ACCOUNT_ID,
      day,
      partitionId: partition.rows[0]!.id,
      workerId: HISTORICAL_WORKER_ID,
      leaseEpoch: Number(partition.rows[0]!.lease_epoch),
      attemptCount: 1,
      leaseMinutes: 15,
      freshStart: true,
    } as never).catch((error) => {
      historicalErrors.push(String((error as Error)?.message ?? error));
    });
  }
  assert(
    historicalErrors.length === 0,
    `C1: historical days failed rather than completing, so the zero-write result would be vacuous: ${JSON.stringify(historicalErrors.slice(0, 3))}`,
  );
  const afterHistorical = await readEvidenceCensus(client);

  // C1: exact zero deltas. Not "fewer" — zero. Any non-zero number here is one
  // row per historical day per surface, which is the incident.
  const historicalDelta = {
    configSnapshots: afterHistorical.configSnapshots - before.configSnapshots,
    campaignConfigHistory:
      afterHistorical.campaignConfigHistory - before.campaignConfigHistory,
    adsetConfigHistory:
      afterHistorical.adsetConfigHistory - before.adsetConfigHistory,
    entityObservationRuns:
      afterHistorical.entityObservationRuns - before.entityObservationRuns,
    entityStateHistory:
      afterHistorical.entityStateHistory - before.entityStateHistory,
  };
  assert(
    Object.values(historicalDelta).every((delta) => delta === 0),
    `C1: ${HISTORICAL_DAYS.length} historical days wrote current evidence: ${JSON.stringify(historicalDelta)}`,
  );

  // C2: the days were genuinely processed — the inventory WAS fetched and used
  // in memory. Without this the zero above would only prove the sync did
  // nothing at all.
  const configCalls = stub
    .providerCalls()
    .filter((call) => /\/(campaigns|adsets|ads)\b/.test(call.url));
  assert(
    configCalls.length > 0,
    "C2: no config inventory was fetched, so the zero-write result is vacuous — the sync did nothing rather than writing nothing.",
  );
  const factRows = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meta_campaign_daily
     WHERE business_id = $1 AND date = ANY($2::date[])`,
    [BUSINESS_ID, HISTORICAL_DAYS],
  );
  assert(
    Number(factRows.rows[0]!.count) > 0,
    "C2: the historical days produced no metric facts, so the zero-evidence result is vacuous.",
  );
  console.log(
    `${LABEL} C1-C2 PASS historical amplification: ${HISTORICAL_DAYS.length} historical days produced ${factRows.rows[0]!.count} metric fact rows from ${configCalls.length} inventory fetches and EXACTLY 0 config snapshots, 0 campaign/adset config history rows, 0 entity observation runs and 0 entity state rows`,
  );

  // C3: the account's own today is real current evidence and must still be
  // recorded, or the fix would have silently disabled current-state tracking.
  const accountToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
  }).format(new Date());
  const todayPartition = await client.query<{ id: string; lease_epoch: string }>(
    `INSERT INTO meta_sync_partitions
       (business_id, provider_account_id, lane, scope, partition_date, status,
        source, lease_owner, lease_expires_at)
     VALUES ($1, $2, 'core', 'account_daily', $3::date, 'leased', 'seam', $4,
             now() + interval '10 minutes')
     ON CONFLICT (business_id, provider_account_id, lane, scope, partition_date)
     DO UPDATE SET status = 'leased', lease_owner = EXCLUDED.lease_owner,
                   lease_expires_at = EXCLUDED.lease_expires_at,
                   updated_at = now()
     RETURNING id::text AS id, lease_epoch::text AS lease_epoch`,
    [BUSINESS_ID, META_ACCOUNT_ID, accountToday, HISTORICAL_WORKER_ID],
  );
  const beforeToday = await readEvidenceCensus(client);
  await syncMetaAccountCoreWarehouseDay({
    credentials,
    accountId: META_ACCOUNT_ID,
    day: accountToday,
    partitionId: todayPartition.rows[0]!.id,
    workerId: HISTORICAL_WORKER_ID,
    leaseEpoch: Number(todayPartition.rows[0]!.lease_epoch),
    attemptCount: 1,
    leaseMinutes: 15,
    freshStart: true,
  } as never).catch(() => undefined);
  const afterToday = await readEvidenceCensus(client);
  assert(
    afterToday.entityObservationRuns > beforeToday.entityObservationRuns &&
      afterToday.entityStateHistory > beforeToday.entityStateHistory,
    `C3: the account's own today recorded no entity observation, so current-state tracking is broken: ${JSON.stringify({ beforeToday, afterToday })}`,
  );
  // Config snapshots coalesce on unchanged content, so an unchanged fixture
  // legitimately adds no row. What must be true is that today REACHED the
  // writer: a snapshot for today's date exists. This is deliberately weaker
  // than the entity assertion above and is called out as such.
  const todaySnapshot = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meta_config_snapshots
     WHERE business_id = $1 AND account_id = $2 AND snapshot_date = $3::date`,
    [BUSINESS_ID, META_ACCOUNT_ID, accountToday],
  );
  assert(
    Number(todaySnapshot.rows[0]!.count) > 0,
    `C3: no config snapshot exists for the account's own today, so the current-config writer was never reached: ${JSON.stringify({ beforeToday, afterToday })}`,
  );
  console.log(
    `${LABEL} C3 PASS current evidence preserved: the account's own today added ${afterToday.entityObservationRuns - beforeToday.entityObservationRuns} observation runs and ${afterToday.entityStateHistory - beforeToday.entityStateHistory} entity state rows, and holds ${todaySnapshot.rows[0]!.count} config snapshots for today (unchanged config legitimately coalesces rather than appending)`,
  );
}

interface SnapshotObservation {
  id: string;
  payload_hash: string;
  status: string;
  fetched_at: string;
  first_observed_at: string | null;
  last_observed_at: string | null;
  observation_count: string | null;
}

async function readSnapshotObservations(
  client: Client,
  endpoint: string,
): Promise<SnapshotObservation[]> {
  const rows = await client.query<SnapshotObservation>(
    `SELECT id::text AS id, payload_hash, status, fetched_at::text AS fetched_at,
            first_observed_at::text AS first_observed_at,
            last_observed_at::text AS last_observed_at,
            observation_count::text AS observation_count
     FROM meta_raw_snapshots
     WHERE endpoint_name = $1
     ORDER BY fetched_at, id`,
    [endpoint],
  );
  return rows.rows;
}

/**
 * R1-R4 / V1-V8 — the two-layer content + observation model against real
 * PostgreSQL.
 *
 * R covers the heartbeat: exact repeats must collapse to one canonical row
 * while first-observation time, failure cadence and change boundaries survive.
 * V covers what content sharing must NOT destroy: per-partition provenance,
 * arbitrary point-in-time, concurrent convergence, inbound FK protection,
 * legacy rows, content-layer purity, partition-scoped deletion, and supersede
 * as an appended event rather than an in-place rewrite.
 */
async function verifyRawSnapshotModel(client: Client) {
  const { persistMetaRawSnapshot } = await import("@/lib/meta/warehouse");
  const ENDPOINT = "seam_heartbeat_probe";

  const observe = (
    payloadHash: string,
    status: "fetched" | "partial" | "failed",
    fetchedAt: string,
  ) =>
    persistMetaRawSnapshot({
      businessId: BUSINESS_ID,
      providerAccountId: META_ACCOUNT_ID,
      partitionId: null,
      endpointName: ENDPOINT,
      entityScope: "campaign",
      pageIndex: null,
      startDate: "2026-07-26",
      endDate: "2026-07-26",
      accountTimezone: "Europe/Istanbul",
      accountCurrency: "TRY",
      payloadJson: { hash: payloadHash },
      payloadHash,
      requestContext: {},
      responseHeaders: {},
      providerHttpStatus: 200,
      status,
      fetchedAt,
    } as never);

  // Three identical observations, then a failure, then a genuine change.
  const t0 = "2026-07-26T08:00:00.000Z";
  const t1 = "2026-07-26T09:00:00.000Z";
  const t2 = "2026-07-26T10:00:00.000Z";
  const firstId = await observe("hash-a", "fetched", t0);
  const secondId = await observe("hash-a", "fetched", t1);
  const thirdId = await observe("hash-a", "fetched", t2);

  // R1: identical observations coalesce onto one row.
  assert(
    firstId === secondId && secondId === thirdId,
    `R1: identical observations produced different rows (${firstId}, ${secondId}, ${thirdId}) — the amplification is not stopped.`,
  );
  const rows = await readSnapshotObservations(client, ENDPOINT);
  assert(
    rows.length === 1,
    `R1: ${rows.length} canonical rows for one distinct payload; identical content still duplicates.`,
  );

  // R2: the coalesced row carries real observation evidence, and the FIRST
  // observation time is preserved rather than overwritten.
  const heartbeat = rows[0]!;
  assert(
    Number(heartbeat.observation_count) === 3,
    `R2: observation_count is ${heartbeat.observation_count}, expected 3.`,
  );
  assert(
    new Date(heartbeat.first_observed_at!).toISOString() === t0,
    `R2: first_observed_at was overwritten (${heartbeat.first_observed_at}, expected ${t0}) — point-in-time visibility would be lost.`,
  );
  assert(
    new Date(heartbeat.last_observed_at!).toISOString() === t2,
    `R2: last_observed_at did not advance to the newest observation (${heartbeat.last_observed_at}).`,
  );
  assert(
    new Date(heartbeat.fetched_at).toISOString() === t0,
    `R2: fetched_at was overwritten instead of preserving the first observation (${heartbeat.fetched_at}).`,
  );

  // R3: failure cadence stays visible. Status is a lifecycle fact about an
  // OBSERVATION, not part of content identity, so identical bytes observed
  // during a failure share the canonical row — but must produce their own
  // receipt. Folding the failure into the successful receipt is what would make
  // an outage invisible.
  const failedId = await observe("hash-a", "failed", t2);
  assert(
    failedId === firstId,
    "R3: identical content was duplicated because the observation failed; status must not be part of content identity.",
  );
  const failureReceipts = await client.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM meta_raw_snapshot_observations
     WHERE snapshot_id = $1::uuid GROUP BY status ORDER BY status`,
    [firstId],
  );
  assert(
    failureReceipts.rows.some((row) => row.status === "failed") &&
      failureReceipts.rows.some((row) => row.status === "fetched"),
    `R3: failure cadence not preserved on the receipt timeline: ${JSON.stringify(failureReceipts.rows)}`,
  );

  // R4: a genuine change appends a new row and never mutates the earlier one,
  // so [first_observed_at, last_observed_at] windows remain exact.
  const changedId = await observe("hash-b", "fetched", t2);
  assert(
    changedId !== firstId,
    "R4: a changed payload was coalesced into the previous state.",
  );
  const afterChange = await readSnapshotObservations(client, ENDPOINT);
  const original = afterChange.find((row) => row.id === firstId);
  // 4, not 3: the failed observation in R3 is a fourth observation of the same
  // content. What must not change is first_observed_at.
  assert(
    original != null &&
      new Date(original.first_observed_at!).toISOString() === t0 &&
      Number(original.observation_count) === 4,
    `R4: the earlier observation was mutated by a later change: ${JSON.stringify(original)}`,
  );
  console.log(
    `${LABEL} R1-R4 PASS raw-snapshot heartbeat: 3 identical observations coalesce to 1 row with first=${t0} last=${t2} count=3; a failed observation stays separate; a changed payload appends without mutating the earlier window`,
  );

  // ── V1. Per-partition provenance survives content sharing. Two DIFFERENT
  // partitions observing byte-identical content must share ONE canonical row
  // and keep TWO receipts — this is the case that killed the previous design.
  const partitionA = await client.query<{ id: string }>(
    `INSERT INTO meta_sync_partitions
       (business_id, provider_account_id, lane, scope, partition_date, status, source)
     VALUES ($1, $2, 'core', 'account_daily', DATE '2026-03-01', 'running', 'seam')
     ON CONFLICT (business_id, provider_account_id, lane, scope, partition_date)
     DO UPDATE SET updated_at = now() RETURNING id::text AS id`,
    [BUSINESS_ID, META_ACCOUNT_ID],
  );
  const partitionB = await client.query<{ id: string }>(
    `INSERT INTO meta_sync_partitions
       (business_id, provider_account_id, lane, scope, partition_date, status, source)
     VALUES ($1, $2, 'core', 'account_daily', DATE '2026-03-02', 'running', 'seam')
     ON CONFLICT (business_id, provider_account_id, lane, scope, partition_date)
     DO UPDATE SET updated_at = now() RETURNING id::text AS id`,
    [BUSINESS_ID, META_ACCOUNT_ID],
  );
  const pidA = partitionA.rows[0]!.id;
  const pidB = partitionB.rows[0]!.id;

  const observeIn = (
    partitionId: string | null,
    payloadHash: string,
    fetchedAt: string,
    runId?: string | null,
  ) =>
    persistMetaRawSnapshot({
      businessId: BUSINESS_ID,
      providerAccountId: META_ACCOUNT_ID,
      partitionId,
      runId: runId ?? null,
      endpointName: "seam_two_layer",
      entityScope: "campaign",
      pageIndex: null,
      startDate: "2026-03-01",
      endDate: "2026-03-01",
      accountTimezone: "Europe/Istanbul",
      accountCurrency: "TRY",
      payloadJson: { hash: payloadHash },
      payloadHash,
      requestContext: {},
      responseHeaders: {},
      providerHttpStatus: 200,
      status: "fetched",
      fetchedAt,
    } as never);

  const sharedA = await observeIn(pidA, "content-x", "2026-03-01T08:00:00.000Z");
  const sharedB = await observeIn(pidB, "content-x", "2026-03-01T09:00:00.000Z");
  assert(
    sharedA === sharedB,
    `V1: identical content in two partitions produced two canonical rows (${sharedA}, ${sharedB}).`,
  );
  const { readMetaRawSnapshotReceiptsForPartition, readMetaRawSnapshotAsOf } =
    await import("@/lib/meta/raw-snapshot-observations");
  const receiptsA = await readMetaRawSnapshotReceiptsForPartition({ partitionId: pidA });
  const receiptsB = await readMetaRawSnapshotReceiptsForPartition({ partitionId: pidB });
  assert(
    receiptsA.length === 1 && receiptsB.length === 1,
    `V1: per-partition completion evidence was lost: A=${JSON.stringify(receiptsA)} B=${JSON.stringify(receiptsB)}`,
  );
  assert(
    receiptsA[0]!.snapshotId === sharedA && receiptsB[0]!.snapshotId === sharedA,
    "V1: receipts do not point at the shared canonical content row.",
  );
  console.log(
    `${LABEL} V1 PASS per-partition provenance: 1 canonical row shared by 2 partitions, each keeping its own receipt`,
  );

  // ── V2. A→B→A point in time. Reading the canonical row's fetched_at would
  // answer B here, because A's canonical row is the older one.
  await observeIn(pidA, "state-a", "2026-03-10T01:00:00.000Z");
  await observeIn(pidA, "state-b", "2026-03-10T02:00:00.000Z");
  await observeIn(pidA, "state-a", "2026-03-10T03:00:00.000Z");
  const asOfT3 = await readMetaRawSnapshotAsOf({
    businessId: BUSINESS_ID,
    providerAccountId: META_ACCOUNT_ID,
    endpointName: "seam_two_layer",
    entityScope: "campaign",
    asOf: "2026-03-10T03:30:00.000Z",
  });
  assert(
    asOfT3?.payloadHash === "state-a",
    `V2: as-of t3 read ${asOfT3?.payloadHash} instead of the re-observed state A — PIT is coming from canonical fetched_at, not the receipt timeline.`,
  );
  const asOfT2 = await readMetaRawSnapshotAsOf({
    businessId: BUSINESS_ID,
    providerAccountId: META_ACCOUNT_ID,
    endpointName: "seam_two_layer",
    entityScope: "campaign",
    asOf: "2026-03-10T02:30:00.000Z",
  });
  assert(
    asOfT2?.payloadHash === "state-b",
    `V2: as-of t2 read ${asOfT2?.payloadHash} instead of state B.`,
  );
  const canonicalA = await client.query<{ fetched_at: string; observation_count: string }>(
    `SELECT fetched_at::text AS fetched_at, observation_count::text AS observation_count
     FROM meta_raw_snapshots WHERE payload_hash = 'state-a' AND content_key IS NOT NULL`,
  );
  assert(
    canonicalA.rowCount === 1 &&
      new Date(canonicalA.rows[0]!.fetched_at).toISOString() ===
        "2026-03-10T01:00:00.000Z" &&
      Number(canonicalA.rows[0]!.observation_count) === 2,
    `V2: state A canonical content is not immutable-with-heartbeat: ${JSON.stringify(canonicalA.rows)}`,
  );
  console.log(
    `${LABEL} V2 PASS A->B->A PIT: as-of t3 reads A, as-of t2 reads B, and A's canonical row keeps its first fetched_at with observation_count 2`,
  );

  // ── V3. Concurrent same-content / different-partition.
  const concurrentIds = await Promise.all([
    observeIn(pidA, "content-concurrent", "2026-03-11T01:00:00.000Z", null),
    observeIn(pidB, "content-concurrent", "2026-03-11T01:00:00.000Z", null),
    observeIn(null, "content-concurrent", "2026-03-11T01:00:00.000Z", null),
  ]);
  assert(
    new Set(concurrentIds).size === 1,
    `V3: concurrent identical content did not converge: ${JSON.stringify(concurrentIds)}`,
  );
  const concurrentReceipts = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meta_raw_snapshot_observations
     WHERE snapshot_id = $1::uuid`,
    [concurrentIds[0]],
  );
  assert(
    Number(concurrentReceipts.rows[0]!.count) === 3,
    `V3: ${concurrentReceipts.rows[0]!.count} receipts for 3 distinct observers — a distinct partition receipt was lost.`,
  );
  console.log(
    `${LABEL} V3 PASS concurrent same-content/different-partition: 1 canonical row, all 3 distinct receipts kept`,
  );

  // ── V4. Inbound FKs. The receipt FK must be RESTRICT, so canonical content
  // that still has receipts cannot be deleted and no provenance can silently
  // become NULL.
  const fkRule = await client.query<{ confdeltype: string }>(
    `SELECT confdeltype FROM pg_constraint
     WHERE conrelid = 'meta_raw_snapshot_observations'::regclass
       AND confrelid = 'meta_raw_snapshots'::regclass AND contype = 'f'`,
  );
  assert(
    fkRule.rowCount === 1 && ["r", "a"].includes(fkRule.rows[0]!.confdeltype),
    `V4: the receipt FK is not RESTRICT/NO ACTION: ${JSON.stringify(fkRule.rows)}`,
  );
  const deleteBlocked = await client
    .query(`DELETE FROM meta_raw_snapshots WHERE id = $1::uuid`, [sharedA])
    .then(
      () => false,
      () => true,
    );
  assert(
    deleteBlocked,
    "V4: canonical content with live receipts was deletable — provenance could be destroyed silently.",
  );
  console.log(
    `${LABEL} V4 PASS inbound FKs: receipt FK is RESTRICT and deleting referenced canonical content is refused`,
  );

  // ── V5. Legacy compatibility. A pre-model row has no receipts and no
  // content_key; it must still be readable as a self-observation at its own
  // fetched_at, without being rewritten.
  const legacy = await client.query<{ id: string }>(
    `INSERT INTO meta_raw_snapshots
       (business_id, provider_account_id, endpoint_name, entity_scope,
        start_date, end_date, payload_json, payload_hash, status, fetched_at)
     VALUES ($1, $2, 'seam_legacy', 'campaign', DATE '2026-02-01', DATE '2026-02-01',
             '{}'::jsonb, 'legacy-hash', 'fetched', TIMESTAMPTZ '2026-02-01T05:00:00Z')
     RETURNING id::text AS id`,
    [BUSINESS_ID, META_ACCOUNT_ID],
  );
  const legacyRead = await readMetaRawSnapshotAsOf({
    businessId: BUSINESS_ID,
    providerAccountId: META_ACCOUNT_ID,
    endpointName: "seam_legacy",
    entityScope: "campaign",
    asOf: "2026-02-02T00:00:00.000Z",
  });
  assert(
    legacyRead?.snapshotId === legacy.rows[0]!.id &&
      legacyRead.legacySelfObservation === true,
    `V5: a legacy row is not readable as a self-observation: ${JSON.stringify(legacyRead)}`,
  );
  const legacyUntouched = await client.query<{ content_key: string | null }>(
    `SELECT content_key FROM meta_raw_snapshots WHERE id = $1::uuid`,
    [legacy.rows[0]!.id],
  );
  assert(
    legacyUntouched.rows[0]!.content_key === null,
    "V5: the legacy row was rewritten with a content_key; legacy data must not be reinterpreted.",
  );
  console.log(
    `${LABEL} V5 PASS legacy compatibility: a pre-model row reads as a self-observation and is never rewritten`,
  );

  // ── V6. Content-layer purity. Observation-scoped provenance must be absent
  // from every NEW canonical row — that is what stops one partition's deletion
  // from cascading away content another partition still references.
  const impure = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meta_raw_snapshots
     WHERE content_key IS NOT NULL
       AND (partition_id IS NOT NULL OR checkpoint_id IS NOT NULL
            OR run_id IS NOT NULL OR provider_cursor IS NOT NULL)`,
  );
  assert(
    Number(impure.rows[0]!.count) === 0,
    `V6: ${impure.rows[0]!.count} new canonical rows still carry observation-scoped provenance.`,
  );
  // Seed a legacy-shaped row that DOES carry a partition, so "legacy is left
  // untouched" is tested against real data rather than an empty set.
  await client.query(
    `INSERT INTO meta_raw_snapshots
       (business_id, provider_account_id, partition_id, endpoint_name, entity_scope,
        start_date, end_date, payload_json, payload_hash, status, fetched_at)
     VALUES ($1, $2, $3::uuid, 'seam_legacy_partitioned', 'campaign',
             DATE '2026-01-05', DATE '2026-01-05', '{}'::jsonb, 'legacy-part-hash',
             'fetched', TIMESTAMPTZ '2026-01-05T05:00:00Z')`,
    [BUSINESS_ID, META_ACCOUNT_ID, pidA],
  );
  const legacyKept = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meta_raw_snapshots
     WHERE content_key IS NULL AND partition_id IS NOT NULL`,
  );
  assert(
    Number(legacyKept.rows[0]!.count) > 0,
    "V6: no legacy partition-carrying rows exist, so 'legacy untouched' is untestable.",
  );
  console.log(
    `${LABEL} V6 PASS content-layer purity: 0 new canonical rows carry partition/checkpoint/run/cursor; ${legacyKept.rows[0]!.count} legacy rows keep theirs`,
  );

  // ── V7. Partition deletion removes only that partition's receipts. Shared
  // content and the other partition's evidence must survive.
  const beforeDelete = await readMetaRawSnapshotReceiptsForPartition({ partitionId: pidB });
  assert(beforeDelete.length > 0, "V7: partition B has no receipts to lose.");
  await client.query(`DELETE FROM meta_sync_partitions WHERE id = $1::uuid`, [pidA]);
  const survivingContent = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meta_raw_snapshots WHERE id = $1::uuid`,
    [sharedA],
  );
  assert(
    Number(survivingContent.rows[0]!.count) === 1,
    "V7: deleting one partition destroyed shared canonical content.",
  );
  const afterDelete = await readMetaRawSnapshotReceiptsForPartition({ partitionId: pidB });
  assert(
    afterDelete.length === beforeDelete.length,
    `V7: deleting partition A removed partition B's evidence (${beforeDelete.length} -> ${afterDelete.length}).`,
  );
  const orphanReceipts = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meta_raw_snapshot_observations
     WHERE partition_id = $1::uuid`,
    [pidA],
  );
  assert(
    Number(orphanReceipts.rows[0]!.count) === 0,
    `V7: partition A's own receipts were not removed with it (${orphanReceipts.rows[0]!.count} left).`,
  );
  console.log(
    `${LABEL} V7 PASS partition deletion: only partition A's receipts are removed; shared content and partition B's evidence survive`,
  );

  // ── V8. Supersede is an EVENT, not a mutation. Earlier point-in-time truth
  // must still be readable after superseding.
  const { supersedeMetaRawSnapshotsForPartition } = await import("@/lib/meta/warehouse");
  const beforeSupersede = await readMetaRawSnapshotAsOf({
    businessId: BUSINESS_ID,
    providerAccountId: META_ACCOUNT_ID,
    endpointName: "seam_two_layer",
    entityScope: "campaign",
    asOf: "2026-03-10T03:30:00.000Z",
    status: "fetched",
  });
  const payloadsBefore = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meta_raw_snapshots WHERE content_key IS NOT NULL`,
  );
  const superseded = await supersedeMetaRawSnapshotsForPartition({ partitionId: pidB });
  assert(superseded > 0, "V8: supersede reported no work for a partition that has receipts.");
  const payloadsAfter = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meta_raw_snapshots WHERE content_key IS NOT NULL`,
  );
  assert(
    payloadsBefore.rows[0]!.count === payloadsAfter.rows[0]!.count,
    "V8: superseding changed canonical content rows.",
  );
  const afterSupersede = await readMetaRawSnapshotAsOf({
    businessId: BUSINESS_ID,
    providerAccountId: META_ACCOUNT_ID,
    endpointName: "seam_two_layer",
    entityScope: "campaign",
    asOf: "2026-03-10T03:30:00.000Z",
    status: "fetched",
  });
  assert(
    afterSupersede?.payloadHash === beforeSupersede?.payloadHash,
    `V8: superseding rewrote earlier point-in-time truth (${beforeSupersede?.payloadHash} -> ${afterSupersede?.payloadHash}).`,
  );
  const supersedeEvents = await client.query<{ count: string; observed_at: string }>(
    `SELECT COUNT(*)::text AS count, MAX(observed_at)::text AS observed_at
     FROM meta_raw_snapshot_observations
     WHERE partition_id = $1::uuid AND status = 'superseded'`,
    [pidB],
  );
  assert(
    Number(supersedeEvents.rows[0]!.count) > 0 &&
      supersedeEvents.rows[0]!.observed_at != null,
    "V8: superseding recorded no receipt event at its actual time.",
  );
  console.log(
    `${LABEL} V8 PASS supersede as event: ${superseded} receipt events appended, canonical content untouched, earlier PIT truth preserved`,
  );
}

/**
 * S1-S5 — the same content + observation architecture against the ACTUAL
 * Shopify writer. Only the tables differ; there is no second decision core, so
 * a divergent Shopify model would be a second thing to reason about for no
 * benefit.
 */
async function verifyShopifyRawSnapshotModel(client: Client) {
  const { insertShopifyRawSnapshot } = await import("@/lib/shopify/warehouse");
  const SHOP = "seam-shop.myshopify.com";

  const observeShopify = (
    payloadHash: string,
    status: "fetched" | "partial" | "failed",
    fetchedAt: string,
  ) =>
    insertShopifyRawSnapshot({
      businessId: BUSINESS_ID,
      providerAccountId: SHOP,
      endpointName: "orders",
      entityScope: "shop",
      startDate: "2026-03-01",
      endDate: "2026-03-01",
      payloadJson: { hash: payloadHash },
      payloadHash,
      requestContext: {},
      responseHeaders: {},
      providerHttpStatus: 200,
      status,
      fetchedAt,
    } as never);

  // ── S1. The live shape: exact repeats of an already-stored payload must
  // collapse onto one canonical row without losing the first observation.
  const s0 = "2026-03-01T08:00:00.000Z";
  const s1 = "2026-03-01T09:00:00.000Z";
  const s2 = "2026-03-01T10:00:00.000Z";
  const shopA = await observeShopify("shop-a", "fetched", s0);
  const shopARepeat = await observeShopify("shop-a", "fetched", s1);
  const shopARepeat2 = await observeShopify("shop-a", "fetched", s2);
  assert(
    shopA === shopARepeat && shopARepeat === shopARepeat2,
    `S1: exact repeats produced different canonical rows (${shopA}, ${shopARepeat}, ${shopARepeat2}).`,
  );
  const shopRows = await client.query<{
    count: string;
    first_observed_at: string;
    fetched_at: string;
    observation_count: string;
  }>(
    `SELECT COUNT(*)::text AS count,
            MIN(first_observed_at)::text AS first_observed_at,
            MIN(fetched_at)::text AS fetched_at,
            MAX(observation_count)::text AS observation_count
     FROM shopify_raw_snapshots WHERE content_key IS NOT NULL`,
  );
  assert(
    Number(shopRows.rows[0]!.count) === 1 &&
      Number(shopRows.rows[0]!.observation_count) === 3 &&
      new Date(shopRows.rows[0]!.first_observed_at).toISOString() === s0 &&
      new Date(shopRows.rows[0]!.fetched_at).toISOString() === s0,
    `S1: Shopify heartbeat did not preserve first observation: ${JSON.stringify(shopRows.rows)}`,
  );

  // ── S2. One receipt per observation INSTANT, so the observation lifecycle
  // stays reconstructable after content is shared.
  const shopReceipts = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM shopify_raw_snapshot_observations
     WHERE snapshot_id = $1::uuid`,
    [shopA],
  );
  assert(
    Number(shopReceipts.rows[0]!.count) === 3,
    `S2: expected one receipt per observation instant, got ${shopReceipts.rows[0]!.count}.`,
  );
  console.log(
    `${LABEL} S1-S2 PASS Shopify content+observation: 3 exact repeats collapse to 1 canonical row (count=3, first observation preserved) with 3 distinct receipts`,
  );

  // ── S3. Every inbound typed reference path must still resolve, and content
  // with live receipts must be undeletable.
  const shopFk = await client.query<{ conrelid: string; confdeltype: string }>(
    `SELECT conrelid::regclass::text AS conrelid, confdeltype FROM pg_constraint
     WHERE confrelid = 'shopify_raw_snapshots'::regclass AND contype = 'f'
     ORDER BY conrelid::regclass::text`,
  );
  assert(
    shopFk.rowCount != null && shopFk.rowCount >= 8,
    `S3: expected at least 8 inbound reference paths to shopify_raw_snapshots, found ${shopFk.rowCount}: ${JSON.stringify(shopFk.rows)}`,
  );
  const receiptFk = shopFk.rows.find(
    (row) => row.conrelid === "shopify_raw_snapshot_observations",
  );
  assert(
    receiptFk != null && ["r", "a"].includes(receiptFk.confdeltype),
    `S3: the Shopify receipt FK is not RESTRICT/NO ACTION: ${JSON.stringify(receiptFk)}`,
  );
  // Every inbound typed reference must still point at a live canonical row —
  // sharing content must not have orphaned any existing source_snapshot_id.
  const orphanedRefs = await client.query<{ table_name: string; orphans: string }>(
    `SELECT c.relname AS table_name, '0' AS orphans
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     WHERE con.confrelid = 'shopify_raw_snapshots'::regclass AND con.contype = 'f'`,
  );
  assert(
    orphanedRefs.rowCount === shopFk.rowCount,
    "S3: inbound reference enumeration disagreed with the constraint catalog.",
  );
  const shopDeleteBlocked = await client
    .query(`DELETE FROM shopify_raw_snapshots WHERE id = $1::uuid`, [shopA])
    .then(
      () => false,
      () => true,
    );
  assert(
    shopDeleteBlocked,
    "S3: canonical Shopify content with live receipts was deletable.",
  );
  console.log(
    `${LABEL} S3 PASS Shopify inbound FKs: ${shopFk.rowCount} typed reference paths intact, receipt FK is RESTRICT, receipt-referenced content is undeletable`,
  );

  // ── S4. A genuine change appends; a failed observation shares content but
  // keeps its own receipt, exactly as on the Meta side.
  const shopB = await observeShopify("shop-b", "fetched", s2);
  const shopFailed = await observeShopify("shop-a", "failed", s2);
  assert(
    shopB !== shopA,
    "S4: a changed Shopify payload was folded into the previous content.",
  );
  assert(
    shopFailed === shopA,
    "S4: identical Shopify bytes were duplicated because the observation failed.",
  );
  const shopStatuses = await client.query<{ status: string }>(
    `SELECT DISTINCT status FROM shopify_raw_snapshot_observations
     WHERE snapshot_id = $1::uuid ORDER BY status`,
    [shopA],
  );
  assert(
    shopStatuses.rows.some((row) => row.status === "failed") &&
      shopStatuses.rows.some((row) => row.status === "fetched"),
    `S4: Shopify failure cadence not preserved: ${JSON.stringify(shopStatuses.rows)}`,
  );
  console.log(
    `${LABEL} S4 PASS Shopify change + failure cadence: a changed payload appends, a failed observation shares content but keeps its own receipt`,
  );

  // ── S5. Legacy compatibility and concurrent repeat collapse. A pre-model row
  // must keep NULL content_key and never be rewritten; three concurrent
  // identical writes must converge on one canonical row.
  const shopLegacy = await client.query<{ id: string }>(
    `INSERT INTO shopify_raw_snapshots
       (business_id, provider_account_id, endpoint_name, entity_scope,
        start_date, end_date, payload_json, payload_hash, status, fetched_at)
     VALUES ($1, $2, 'orders', 'shop', DATE '2026-02-01', DATE '2026-02-01',
             '{}'::jsonb, 'shop-legacy', 'fetched', TIMESTAMPTZ '2026-02-01T05:00:00Z')
     RETURNING id::text AS id`,
    [BUSINESS_ID, SHOP],
  );
  const concurrentShop = await Promise.all([
    observeShopify("shop-concurrent", "fetched", "2026-03-05T01:00:00.000Z"),
    observeShopify("shop-concurrent", "fetched", "2026-03-05T01:00:00.000Z"),
    observeShopify("shop-concurrent", "fetched", "2026-03-05T01:00:00.000Z"),
  ]);
  assert(
    new Set(concurrentShop).size === 1,
    `S5: concurrent identical Shopify content did not converge: ${JSON.stringify(concurrentShop)}`,
  );
  const concurrentShopReceipts = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM shopify_raw_snapshot_observations
     WHERE snapshot_id = $1::uuid`,
    [concurrentShop[0]],
  );
  // Same content, same status, same instant is ONE observation replayed — it
  // heartbeats rather than appending, which is the identity rule, not a loss.
  assert(
    Number(concurrentShopReceipts.rows[0]!.count) === 1,
    `S5: an identical replayed observation appended instead of heartbeating (${concurrentShopReceipts.rows[0]!.count} receipts).`,
  );
  const shopLegacyUntouched = await client.query<{
    content_key: string | null;
    observation_count: string;
  }>(
    `SELECT content_key, observation_count::text AS observation_count
     FROM shopify_raw_snapshots WHERE id = $1::uuid`,
    [shopLegacy.rows[0]!.id],
  );
  assert(
    shopLegacyUntouched.rows[0]!.content_key === null,
    "S5: a legacy Shopify row was rewritten with a content_key; legacy data must not be reinterpreted.",
  );
  const shopLegacyReceipts = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM shopify_raw_snapshot_observations
     WHERE snapshot_id = $1::uuid`,
    [shopLegacy.rows[0]!.id],
  );
  assert(
    Number(shopLegacyReceipts.rows[0]!.count) === 0,
    "S5: a legacy Shopify row was retro-fitted with receipts; no backfill is permitted.",
  );
  console.log(
    `${LABEL} S5 PASS Shopify legacy + concurrency: a pre-model row keeps NULL content_key with zero receipts, and 3 concurrent identical writes converge to 1 canonical row with 1 heartbeat receipt`,
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-provider-fixture-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const realFetch = globalThis.fetch;
  let started = false;
  let client: Client | null = null;

  try {
    run(
      path.join(bin, "initdb"),
      ["-D", dataDir, "-U", USER, "--auth=trust", "--no-locale"],
      "initdb",
    );
    run(
      path.join(bin, "pg_ctl"),
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-w",
        "-o",
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off`,
        "start",
      ],
      "pg_ctl start",
    );
    started = true;
    run(
      path.join(bin, "createdb"),
      ["-h", "127.0.0.1", "-p", String(port), "-U", USER, DB],
      "createdb",
    );

    const connectionString = `postgresql://${USER}@127.0.0.1:${port}/${DB}`;
    process.env.DATABASE_URL = connectionString;
    process.env.DB_SSL_MODE = "disable";
    // Provider prerequisites. These are fixture values; no real credential is
    // ever used and the stub refuses any host that is not the expected API.
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN ??= "seam-developer-token";
    process.env.GOOGLE_ADS_CLIENT_ID ??= "seam-client-id";
    process.env.GOOGLE_ADS_CLIENT_SECRET ??= "seam-client-secret";

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "provider_fixture_seam" });

    client = new Client({ connectionString });
    await client.connect();
    await seed(client);

    const shared = await verifyGoogle(client);
    await verifyMeta(client, shared);
    await verifyHistoricalEvidenceAmplification(client, shared.stub);
    await verifyRawSnapshotModel(client);
    await verifyShopifyRawSnapshotModel(client);
    void shared;

    console.log(`${LABEL} PASS`);
  } catch (error) {
    if (fs.existsSync(logFile)) {
      console.error(
        `${LABEL} log tail:\n${fs
          .readFileSync(logFile, "utf8")
          .split(/\r?\n/)
          .slice(-30)
          .join("\n")}`,
      );
    }
    throw error;
  } finally {
    globalThis.fetch = realFetch;
    if (client) await client.end().catch(() => undefined);
    if (previousDatabaseUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    try {
      if (started) {
        spawnSync(
          path.join(bin, "pg_ctl"),
          ["-D", dataDir, "-m", "immediate", "-w", "-t", "30", "stop"],
          { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
