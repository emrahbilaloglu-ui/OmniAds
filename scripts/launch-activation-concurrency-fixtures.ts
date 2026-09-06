/** Two independent Node processes exercise the production claim on an isolated PG schema. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getDb, resetDbClientCache } from "@/lib/db";
import { createMetaLaunchActivationActionClaim, findUnresolvedMetaAdStatusActionLog } from "@/lib/meta/ads-action-log";

type WorkerInput = {
  worker: string; businessId: string; account: string; entity: string; intent: string;
  grain: "campaign" | "adset" | "ad"; operator: string | null;
  barrier: number; nonattempt?: boolean;
};
type WorkerResult = { processId: number; claimed: boolean; reason: string | null; before: string | null; logId: string; locksBeforeProvider: number };

async function claimWorker(input: WorkerInput): Promise<WorkerResult> {
  const sql = getDb();
  const before = await findUnresolvedMetaAdStatusActionLog({ businessId: input.businessId, providerAccountId: input.account, adId: input.entity });
  await sql.query("INSERT INTO activation_test_arrivals(worker) VALUES ($1)", [input.worker]);
  const deadline = Date.now() + 10_000;
  while (Number((await sql.query("SELECT count(*) AS n FROM activation_test_arrivals"))[0]?.n) < input.barrier) {
    if (Date.now() > deadline) throw new Error("Activation claim worker barrier timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const claim = await createMetaLaunchActivationActionClaim({
    businessId: input.businessId, providerAccountId: input.account, adId: input.entity,
    launchIntentId: input.intent, requestedBy: input.operator, action: "resume", source: "launch_activation_v1",
    payloadRequest: { scope_type: input.grain, dry_run: false, body: { status: "ACTIVE" } },
  });
  const locksBeforeProvider = Number((await sql.query(
    "SELECT count(*) AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted",
  ))[0]?.n);
  if (claim.claimed) {
    if (locksBeforeProvider !== 0) throw new Error("Provider boundary retained an entity transaction lock");
    // This is the provider double's POST boundary; the actual journal claim is
    // the permission to reach it. No external provider is contacted by a fixture.
    if (!input.nonattempt) await sql.query("INSERT INTO activation_test_provider_posts(action_log_id) VALUES ($1)", [claim.log.id]);
    await sql.query("UPDATE meta_ads_action_log SET status=$2,error_code=$3 WHERE id=$1", [
      claim.log.id, input.nonattempt ? "failure" : "success", input.nonattempt ? "activation_authority_refused" : null,
    ]);
  }
  return { processId: process.pid, claimed: claim.claimed, reason: claim.claimed ? null : claim.reason,
    before: before?.id ?? null, logId: claim.log.id, locksBeforeProvider };
}

if (process.argv.includes("--activation-claim-worker")) {
  void claimWorker(JSON.parse(process.env.ADSECUTE_ACTIVATION_CLAIM_WORKER ?? "{}"))
    .then((result) => console.log(`ACTIVATION_CLAIM_RESULT ${JSON.stringify(result)}`))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => resetDbClientCache());
}

export async function verifyLaunchActivationConcurrencyFixtures(databaseUrl: string): Promise<number> {
  const url = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.port || ["5432", "15432"].includes(url.port)) {
    throw new Error("Activation concurrency fixture requires a disposable loopback database port");
  }
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  const schema = `activation_claim_${randomUUID().replaceAll("-", "")}`;
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  let cases = 0;
  const base = {
    businessId: "c9b30000-0000-4000-8000-000000000001", account: "act_atomic_1", entity: "entity_1",
    intent: "c9b30000-0000-4000-8000-000000000002", grain: "ad" as const,
    operator: "c9b30000-0000-4000-8000-000000000003", barrier: 1,
  };
  const query = (text: string, values?: unknown[]) => admin.query(text, values);
  const fail = (message: string) => { throw new Error(`Activation concurrency: ${message}`); };
  async function worker(overrides: Partial<WorkerInput> = {}) {
    const input: WorkerInput = { ...base, worker: randomUUID(), ...overrides };
    return new Promise<WorkerResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/launch-activation-concurrency-fixtures.ts", "--activation-claim-worker"], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_URL: scopedUrl.toString(), ADSECUTE_ACTIVATION_CLAIM_WORKER: JSON.stringify(input) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { output += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        const line = output.split("\n").find((entry) => entry.startsWith("ACTIVATION_CLAIM_RESULT "));
        if (code !== 0 || !line) reject(new Error(`Activation worker failed (${code}): ${output.slice(-3000)}`));
        else resolve(JSON.parse(line.slice("ACTIVATION_CLAIM_RESULT ".length)));
      });
    });
  }
  const clear = async () => { await query("TRUNCATE meta_ads_action_log,meta_ads_action_reconciliation_events,activation_test_arrivals,activation_test_provider_posts"); };
  const clearBarrier = async () => { await query("TRUNCATE activation_test_arrivals"); };
  const postCount = async () => Number((await query("SELECT count(*) AS n FROM activation_test_provider_posts")).rows[0]?.n);
  try {
    await query(`CREATE SCHEMA ${schema}`);
    await query(`SET search_path=${schema}`);
    await query(`CREATE TABLE meta_ads_action_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, provider_account_ref_id UUID, provider_account_id TEXT,
      ad_id TEXT, creative_id TEXT, action TEXT, source TEXT, requested_by UUID, requested_at TIMESTAMPTZ DEFAULT now(),
      payload_request JSONB, payload_response JSONB, status TEXT, error_code TEXT, error_message TEXT,
      resulting_ad_id TEXT, duration_ms INTEGER, verified_at TIMESTAMPTZ, verification_payload JSONB,
      rec_id_origin TEXT, launch_intent_id UUID, dry_run BOOLEAN, terminal_finalized_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    )`);
    await query(`CREATE TABLE meta_ads_action_reconciliation_events (
      id UUID, source_action_log_id UUID, business_id UUID, ad_id TEXT, action TEXT, provider_account_id TEXT
    )`);
    await query("CREATE TABLE activation_test_arrivals(worker TEXT)");
    await query("CREATE TABLE activation_test_provider_posts(action_log_id UUID)");

    for (const grain of ["campaign", "adset", "ad"] as const) {
      for (const mixed of [false, true]) {
        await clear();
        const results = await Promise.all([
          worker({ grain, barrier: 2 }), worker({ grain, barrier: 2, operator: mixed ? null : base.operator }),
        ]);
        if (new Set(results.map((row) => row.processId)).size !== 2) fail("contenders were not independent processes");
        if (results.some((row) => row.before !== null)) fail("both optimistic lookups must see no earlier attempt");
        if (results.filter((row) => row.claimed).length !== 1 || await postCount() !== 1) fail(`${grain}/${mixed}: duplicate activation dispatch`);
        if (!results.some((row) => ["unresolved_prior_attempt", "activation_already_consumed"].includes(row.reason ?? ""))) fail("loser had no durable refusal");
        cases += 1;
        await clearBarrier();
        const late = await worker({ grain });
        if (late.before !== null || late.claimed || late.reason !== "activation_already_consumed" || await postCount() !== 1) fail("stale PAUSED after completed success was replayed");
        cases += 1;
      }
    }

    for (const state of ["pending", "silent_failure"] as const) {
      await clear();
      await query(`INSERT INTO meta_ads_action_log(business_id,provider_account_id,ad_id,action,source,status,dry_run)
        VALUES($1,$2,$3,'pause','manual_operator_v1',$4,false)`, [base.businessId, base.account, base.entity, state]);
      const refused = await worker();
      if (refused.claimed || refused.reason !== "unresolved_prior_attempt" || await postCount() !== 0) fail(`${state} prior status action did not hold`);
      cases += 1;
    }

    await clear();
    const nonattempt = await worker({ nonattempt: true });
    if (!nonattempt.claimed || await postCount() !== 0) fail("known authority refusal reached provider");
    await clearBarrier();
    const retry = await worker();
    if (!retry.claimed || retry.logId === nonattempt.logId || await postCount() !== 1) fail("known nonattempt could not retry once");
    cases += 1;

    for (const different of [{ entity: "entity_2" }, { account: "act_atomic_2" }, { businessId: "c9b30000-0000-4000-8000-000000000099" }]) {
      await clear();
      const results = await Promise.all([worker({ barrier: 2 }), worker({ ...different, barrier: 2 })]);
      if (results.some((row) => !row.claimed) || await postCount() !== 2) fail("an independent entity/account/business was blocked");
      cases += 1;
    }
    return cases;
  } finally {
    await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}
