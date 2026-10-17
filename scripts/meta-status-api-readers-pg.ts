import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { Client } from "pg";
import { getDb, runPinnedDbTransaction } from "../lib/db";
import { getMetaAdSetDailyCoverage } from "../lib/meta/warehouse";

/** Execute the actual route SQL, not a second implementation of its rules. */
function routeSql(file: string, functionName: string) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const queries: string[] = [];
  function walk(node: ts.Node, inside = false) {
    inside ||= ts.isFunctionDeclaration(node) && node.name?.text === functionName;
    if (inside && ts.isNoSubstitutionTemplateLiteral(node) && node.text.includes("WITH scoped_legacy_snapshots")) queries.push(node.text);
    if (inside && ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)) {
      const template = node.template;
      assert.equal(template.templateSpans.length, 1);
      assert.equal(template.templateSpans[0]!.expression.getText(source), "businessId");
      queries.push(template.head.text + "$1::text" + template.templateSpans[0]!.literal.text);
    }
    ts.forEachChild(node, (child) => walk(child, inside));
  }
  walk(source);
  return queries;
}

export async function verifyMetaStatusApiReadersPg(client: Client) {
  const { rows: [identity] } = await client.query("SELECT current_database() db,host(inet_server_addr()) host,inet_server_port() port");
  assert(["sync_retention_seam", "raw_payload_owned_qa"].includes(identity.db));
  assert(["127.0.0.1", "::1"].includes(identity.host) && ![5432, 15432].includes(identity.port));
  const business = "d1800000-0000-4000-8000-000000000001";
  const foreign = "d1800000-0000-4000-8000-000000000002";
  const dates = routeSql("app/api/meta/decisions-workspace/route.ts", "resolveWorkspaceEndDate");
  const pulse = routeSql("app/api/meta/account-pulse/route.ts", "readEngineMetadata");
  assert.equal(dates.length, 2); assert.equal(pulse.length, 1);
  await runPinnedDbTransaction({ client, timeoutMs: 8000, lockTimeoutMs: 1000, fn: async (db) => {
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    await db.query(`CREATE TEMP TABLE engine_v3_decision_snapshots_daily(business_ref_id uuid,business_id text,creative_id text,as_of_date date) ON COMMIT DROP;
      CREATE INDEX ON engine_v3_decision_snapshots_daily(business_ref_id,as_of_date);
      CREATE TEMP TABLE engine_v3_ad_decision_snapshots_daily(business_ref_id uuid,business_id text,provider_account_id text,as_of_date date) ON COMMIT DROP;
      CREATE TEMP TABLE engine_v3_job_runs(business_ref_id uuid,business_id text,job_name text,as_of_date date) ON COMMIT DROP;
      CREATE TEMP TABLE meta_creative_dimensions(business_id text,provider_account_id text,creative_id text) ON COMMIT DROP;
      CREATE TEMP TABLE meta_creative_daily(business_id text,provider_account_id text,creative_id text) ON COMMIT DROP;
      CREATE TEMP TABLE meta_decision_snapshots_daily(business_id text,kind text,snapshot_date date,created_at timestamptz,engine_version text) ON COMMIT DROP;
      CREATE INDEX ON meta_decision_snapshots_daily(business_id,snapshot_date);
      CREATE TEMP TABLE meta_adset_daily(business_id text,provider_account_id text,date date,updated_at timestamptz) ON COMMIT DROP;
      CREATE INDEX ON meta_adset_daily(business_id,date);
      CREATE TEMP TABLE meta_sync_partitions(business_id text,provider_account_id text,scope text,partition_date date,status text,updated_at timestamptz) ON COMMIT DROP;`);
    await db.query(`INSERT INTO engine_v3_decision_snapshots_daily VALUES
      ($1::uuid,$1::text,'owned-a','2026-01-15'),($1::uuid,$1::text,'owned-b','2026-01-17'),
      ($1::uuid,$1::text,'shared','2026-01-25'),($2::uuid,$2::text,'foreign','2026-01-31');
      `, [business, foreign]);
    await db.query(`INSERT INTO meta_creative_dimensions VALUES ($1,'act-a','owned-a'),($1,'act-b','owned-b'),($1,'act-a','shared'),($2,'act-a','foreign')`, [business, foreign]);
    await db.query("INSERT INTO meta_creative_daily VALUES ($1,'act-b','shared')", [business]);
    await db.query("INSERT INTO engine_v3_ad_decision_snapshots_daily VALUES ($1::uuid,$1::text,'act-a','2026-01-10'),($1::uuid,$1::text,'act-b','2026-01-20')", [business]);
    await db.query("INSERT INTO engine_v3_job_runs VALUES ($1::uuid,$1::text,'engine_v3_native_ad_decisions_shadow_job','2026-01-12')", [business]);
    for (const [account, expected, legacyExpected] of [["act-a", "2026-01-15", "2026-01-15"], ["act-b", "2026-01-20", "2026-01-17"], ["unassigned", "2026-01-12", null]] as const) {
      assert.equal((await db.query(dates[0]!, [business, account]))[0]!.latest_as_of, expected);
      assert.equal((await db.query(dates[1]!, [business, account]))[0]!.latest_as_of, legacyExpected);
    }
    // Real newer legacy dates remain candidates. A native job marker does not
    // silently replace them; cross-account ambiguous creatives stay excluded.
    assert.equal((await db.query(dates[0]!, [foreign, "act-a"]))[0]!.latest_as_of, "2026-01-31");
    await db.query(`INSERT INTO meta_decision_snapshots_daily VALUES
      ($1,'recommendation','2026-01-20','2026-01-21','newer-day'),
      ($1,'recommendation','2026-01-10','2026-01-22','later-backfill'),
      ($1,'other','2026-01-30','2026-01-31','wrong-kind'),
      ($2,'recommendation','2026-01-31','2026-02-01','foreign')`, [business, foreign]);
    assert.equal((await db.query(pulse[0]!, [business]))[0]!.engine_version, "later-backfill");
    assert.equal((await db.query(pulse[0]!, ["missing"])).length, 0);

    await db.query(`INSERT INTO meta_adset_daily VALUES
      ($1,'act-a','2026-01-01','2026-01-10'),($1,'act-a','2026-01-01','2026-01-11'),
      ($1,'act-b','2026-01-03','2026-01-12'),($2,'act-a','2026-01-02','2026-02-01')`, [business, foreign]);
    await db.query(`INSERT INTO meta_adset_daily SELECT $1,'decoy','2026-01-01'::date+(g%30),now() FROM generate_series(1,20000) g`, [foreign]);
    await db.query("ANALYZE meta_adset_daily");
    const coverage = (account: string | null, start = "2026-01-01", end = "2026-01-03") => getMetaAdSetDailyCoverage({ businessId: business, providerAccountId: account, startDate: start, endDate: end });
    const pooled = await coverage(null);
    assert.deepEqual(pooled, { completed_days: 2, first_completed_date: "2026-01-01", ready_through_date: "2026-01-03", latest_updated_at: "2026-01-12T00:00:00.000Z", total_rows: 3 });
    assert.equal((await coverage("act-a")).total_rows, 2);
    assert.equal((await coverage("act-b")).completed_days, 1);
    assert.equal((await coverage("missing")).total_rows, 0);
    assert.equal((await coverage(null, "2026-01-02", "2026-01-02")).completed_days, 0);
    assert.equal((await coverage(null, "2026-01-03", "2026-01-01")).total_rows, 0);
    await db.query("INSERT INTO meta_sync_partitions VALUES ($1,'act-a','adset_daily','2026-01-02','succeeded','2026-01-09')", [business]);
    const withPartition = await coverage(null);
    assert.equal(withPartition.completed_days, 2); // Preserve max(), not union cardinality.
    assert.equal(withPartition.ready_through_date, "2026-01-02");
    assert.equal(withPartition.latest_updated_at, "2026-01-09T00:00:00.000Z");
    assert.equal(withPartition.total_rows, 3);
    // Pinned calls above really used the same temporary fixture connection.
    assert.equal((await getDb().query("SELECT COUNT(*)::int n FROM meta_adset_daily WHERE business_id=$1", [business]))[0]!.n, 3);
  } });
  console.log("[meta-status-api-readers] PASS actual SQL: native/legacy dates, account ambiguity, original backfill ordering, exact daily coverage and partition semantics");
}
