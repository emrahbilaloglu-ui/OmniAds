import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { Client } from "pg";
import { getDb, runPinnedDbTransaction } from "../lib/db";
import { getMetaAdSetDailyCoverage, getMetaBreakdownDailyCoverageByEndpoint } from "../lib/meta/warehouse";
import { FENCED_TABLES, PHYSICAL_TELEMETRY_SOURCE } from "../lib/sync/db-growth-fence";

/** Execute the actual route SQL, not a second implementation of its rules. */
function routeSql(file: string, functionName: string) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const queries: string[] = [];
  function walk(node: ts.Node, inside = false) {
    inside ||= ts.isFunctionDeclaration(node) && node.name?.text === functionName;
    if (inside && ts.isNoSubstitutionTemplateLiteral(node) && node.text.includes("scoped_legacy_snapshots AS MATERIALIZED")) queries.push(node.text);
    if (inside && functionName === "evaluateDbGrowthFenceWithProofOrdering" && ts.isNoSubstitutionTemplateLiteral(node) && node.text.includes("latest_capacity AS")) queries.push(node.text);
    if (inside && ts.isTemplateExpression(node) && node.templateSpans.length === 1 &&
        node.templateSpans[0]!.expression.getText(source) === "input.tableName") {
      queries.push(node.head.text + "meta_adset_daily" + node.templateSpans[0]!.literal.text);
    }
    if (inside && ts.isTemplateExpression(node) && node.templateSpans.length === 1 &&
        node.templateSpans[0]!.expression.getText(source) === "truthPredicate") {
      queries.push(node.head.text + "AND COALESCE(breakdown.truth_state, 'finalized') = 'finalized'" + node.templateSpans[0]!.literal.text);
    }
    if (inside && ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)) {
      const template = node.template;
      if (functionName === "readDecisionDigest") {
        if (node.getText(source).includes("= 'anomaly'")) {
          assert.deepEqual(template.templateSpans.map((span) => span.expression.getText(source)),
            ["input.businessId", "input.entityIds", "since", "since"]);
          queries.push(template.head.text + template.templateSpans.map((span, index) =>
            `$${index + 1}` + span.literal.text).join(""));
        }
        return;
      }
      assert.equal(template.templateSpans.length, 1);
      assert.equal(template.templateSpans[0]!.expression.getText(source), "businessId");
      queries.push(template.head.text + "$1::text" + template.templateSpans[0]!.literal.text);
    }
    ts.forEachChild(node, (child) => walk(child, inside));
  }
  walk(source);
  return queries;
}

function actualMetadataIndexSql() {
  const source = ts.createSourceFile("lib/migrations.ts", readFileSync("lib/migrations.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const matches: string[] = [];
  function walk(node: ts.Node) {
    if (ts.isTaggedTemplateExpression(node) && ts.isNoSubstitutionTemplateLiteral(node.template) &&
        node.template.text.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_decision_snapshots_daily_business_kind_created")) {
      matches.push(node.template.text);
    }
    ts.forEachChild(node, walk);
  }
  walk(source); assert.equal(matches.length, 1);
  // The real key/order is executed on an owned TEMP table. PostgreSQL cannot
  // build a TEMP index concurrently or run CONCURRENTLY inside this fixture TX.
  return matches[0]!.replace(" CONCURRENTLY", "");
}

export async function verifyMetaStatusApiReadersPg(client: Client) {
  const { rows: [identity] } = await client.query("SELECT current_database() db,host(inet_server_addr()) host,inet_server_port() port");
  assert(["sync_retention_seam", "raw_payload_owned_qa"].includes(identity.db));
  assert(["127.0.0.1", "::1"].includes(identity.host) && ![5432, 15432].includes(identity.port));
  const business = "d1800000-0000-4000-8000-000000000001";
  const foreign = "d1800000-0000-4000-8000-000000000002";
  const dates = routeSql("app/api/meta/decisions-workspace/route.ts", "resolveWorkspaceEndDate");
  const pulse = routeSql("app/api/meta/account-pulse/route.ts", "readEngineMetadata");
  const coverageQueries = routeSql("lib/meta/warehouse.ts", "getMetaCoverageForTable");
  const breakdownQueries = routeSql("lib/meta/warehouse.ts", "getMetaBreakdownDailyCoverageByEndpoint");
  const anomalies = routeSql("app/api/meta/decisions-workspace/route.ts", "readDecisionDigest");
  const capacity = routeSql("lib/sync/db-growth-fence.ts", "evaluateDbGrowthFenceWithProofOrdering");
  assert.equal(dates.length, 2); assert.equal(pulse.length, 1); assert.equal(coverageQueries.length, 1);
  assert.equal(breakdownQueries.length, 1);
  assert.equal(anomalies.length, 1);
  assert.equal(capacity.length, 1);
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
    await db.query(actualMetadataIndexSql());
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
    // A native tie already determines the maximum. A genuinely newer legacy
    // date must still win, and ambiguity includes bindings from all history.
    await db.query("INSERT INTO engine_v3_ad_decision_snapshots_daily VALUES ($1::uuid,$1::text,'act-a','2026-01-15')", [business]);
    assert.equal((await db.query(dates[0]!, [business, "act-a"]))[0]!.latest_as_of, "2026-01-15");
    await db.query("INSERT INTO engine_v3_decision_snapshots_daily VALUES ($1::uuid,$1::text,'owned-a','2026-01-16')", [business]);
    assert.equal((await db.query(dates[0]!, [business, "act-a"]))[0]!.latest_as_of, "2026-01-16");
    await db.query("INSERT INTO engine_v3_job_runs VALUES ($1::uuid,$1::text,'engine_v3_native_ad_decisions_shadow_job','2026-01-30')", [business]);
    await db.query(`INSERT INTO engine_v3_decision_snapshots_daily VALUES
      ($1::uuid,$1::text,'owned-b','2026-01-31'),($1::uuid,$1::text,'shared','2026-02-01'),
      ($1::uuid,$2::text,'owned-a','2035-01-01'),($2::uuid,$1::text,'owned-a','2035-01-01'),
      ($1::uuid,$1::text,'owned-a',NULL)`, [business, foreign]);
    await db.query(`INSERT INTO engine_v3_ad_decision_snapshots_daily VALUES
      ($1::uuid,$2::text,'act-a','2035-01-01'),($2::uuid,$1::text,'act-a','2035-01-01')`, [business, foreign]);
    await db.query(`INSERT INTO engine_v3_job_runs VALUES
      ($1::uuid,$2::text,'engine_v3_native_ad_decisions_shadow_job','2035-01-01'),
      ($2::uuid,$1::text,'engine_v3_native_ad_decisions_shadow_job','2035-01-01')`, [business, foreign]);
    for (const [account, expected] of [["act-a", "2026-01-30"], ["act-b", "2026-01-31"], ["unassigned", "2026-01-30"]]) {
      assert.equal((await db.query(dates[0]!, [business, account]))[0]!.latest_as_of, expected);
    }
    const empty = "d1800000-0000-4000-8000-000000000003";
    assert.equal((await db.query(dates[0]!, [empty, "act-a"]))[0]!.latest_as_of, null);
    // Owned old history must not expand the membership work or defeat the
    // existing (business_ref_id,as_of_date) range index.
    await db.query(`INSERT INTO engine_v3_decision_snapshots_daily
      SELECT $1::uuid,$1::text,'owned-a','2019-01-01'::date+(g%30)
      FROM generate_series(1,20000) g`, [business]);
    await db.query("ANALYZE engine_v3_decision_snapshots_daily");
    const [datePlanRow] = await db.query("EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) " + dates[0]!, [business, "act-a"]);
    const dateNodes: Record<string, unknown>[] = [];
    collect(datePlanRow!["QUERY PLAN"][0].Plan, dateNodes);
    assert(dateNodes.some((node) => /business_ref_id/.test(String(node["Index Cond"])) && /as_of_date/.test(String(node["Index Cond"]))));
    assert(dateNodes.filter((node) => node["Relation Name"] === "engine_v3_decision_snapshots_daily")
      .every((node) => Number(node["Actual Rows"]) <= 3));
    assert.equal((await db.query(dates[0]!, [business, "act-a"]))[0]!.latest_as_of, "2026-01-30");
    await db.query(`INSERT INTO meta_decision_snapshots_daily VALUES
      ($1,'recommendation','2026-01-20','2026-01-21','newer-day'),
      ($1,'recommendation','2026-01-10','2026-01-22','later-backfill'),
      ($1,'other','2026-01-30','2026-01-31','wrong-kind'),
      ($2,'recommendation','2026-01-31','2026-02-01','foreign')`, [business, foreign]);
    await db.query(`INSERT INTO meta_decision_snapshots_daily
      SELECT $1,'recommendation','2026-01-31','2026-02-01'::timestamptz+g*interval '1 second','foreign-newer'
      FROM generate_series(1,20000) g`, [foreign]);
    await db.query("ANALYZE meta_decision_snapshots_daily");
    assert.equal((await db.query(pulse[0]!, [business]))[0]!.engine_version, "later-backfill");
    assert.equal((await db.query(pulse[0]!, ["missing"])).length, 0);
    const [metadataPlanRow] = await db.query("EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) " + pulse[0]!, [business]);
    const metadataNodes: Record<string, unknown>[] = [];
    function collect(node: Record<string, unknown>, into: Record<string, unknown>[]) {
      into.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) collect(child, into);
    }
    collect(metadataPlanRow!["QUERY PLAN"][0].Plan, metadataNodes);
    assert(metadataNodes.some((node) => node["Index Name"] === "idx_meta_decision_snapshots_daily_business_kind_created" &&
      /business_id/.test(String(node["Index Cond"])) && /kind/.test(String(node["Index Cond"]))));
    assert(!metadataNodes.some((node) => ["Sort", "Seq Scan"].includes(String(node["Node Type"]))));

    await db.query(`ALTER TABLE meta_decision_snapshots_daily
      ADD COLUMN rec_id text, ADD COLUMN evidence jsonb, ADD COLUMN reasoning text,
      ADD COLUMN scope_id text, ADD COLUMN resolved_at timestamptz, ADD COLUMN detected_at timestamptz`);
    await db.query(`INSERT INTO meta_decision_snapshots_daily
      (business_id,kind,created_at,rec_id,evidence,reasoning,scope_id,resolved_at,detected_at) VALUES
      ($1,'anomaly','2026-02-03','open','{"title":"Open alert"}',NULL,'scope-a',NULL,NULL),
      ($1,'anomaly','2026-02-02','resolved','{"name":"Old alert"}',NULL,'scope-a','2026-02-03','2026-02-02'),
      ($1,'anomaly','2026-01-01','outside-window','{}','Earlier','scope-a',NULL,NULL),
      ($1,'anomaly','2026-02-04','wrong-scope','{}','Other','scope-b',NULL,NULL),
      ($2,'anomaly','2026-02-04','foreign','{}','Foreign','scope-a',NULL,NULL),
      ($1,NULL,'2026-02-04','legacy-null','{}','anomaly','scope-a',NULL,NULL),
      ($1,'recommendation','2026-02-04','recommendation','{}','anomaly','scope-a',NULL,NULL)`, [business, foreign]);
    await db.query(`INSERT INTO meta_decision_snapshots_daily
      (business_id,kind,created_at,rec_id,scope_id)
      SELECT $1,'recommendation','2026-02-04','decoy-'||g,'scope-a'
      FROM generate_series(1,20000) g`, [business]);
    await db.query("ANALYZE meta_decision_snapshots_daily");
    const anomalyArgs = [business, ["scope-a"], "2026-02-01", "2026-02-01"];
    const actualAnomalies = await db.query(anomalies[0]!, anomalyArgs);
    assert.deepEqual(actualAnomalies.map((row) => [row.id, row.title, row.status]),
      [["open", "Open alert", "open"], ["resolved", "Old alert", "resolved"]]);
    const oldAnomalySql = anomalies[0]!.replace("snapshot.kind = 'anomaly'", "COALESCE(snapshot.kind, 'recommendation') = 'anomaly'");
    assert.deepEqual(actualAnomalies, await db.query(oldAnomalySql, anomalyArgs));
    assert.equal((await db.query(anomalies[0]!, [business, [], null, null])).length, 0);
    assert.equal((await db.query(anomalies[0]!, [business, ["scope-a"], null, null])).length, 3);
    const [anomalyPlanRow] = await db.query("EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) " + anomalies[0]!, anomalyArgs);
    const anomalyNodes: Record<string, unknown>[] = [];
    collect(anomalyPlanRow!["QUERY PLAN"][0].Plan, anomalyNodes);
    assert(anomalyNodes.some((node) => node["Index Name"] === "idx_meta_decision_snapshots_daily_business_kind_created" &&
      /business_id/.test(String(node["Index Cond"])) && /kind/.test(String(node["Index Cond"]))));
    assert(anomalyNodes.filter((node) => node["Relation Name"] === "meta_decision_snapshots_daily")
      .every((node) => Number(node["Actual Rows"]) <= 4));

    await db.query(`INSERT INTO meta_adset_daily VALUES
      ($1,'act-a','2026-01-01','2026-01-10'),($1,'act-a','2026-01-01','2026-01-11'),
      ($1,'act-b','2026-01-03','2026-01-12'),($2,'act-a','2026-01-02','2026-02-01')`, [business, foreign]);
    await db.query(`INSERT INTO meta_adset_daily SELECT $1,'decoy','2026-01-01'::date+(g%30),now() FROM generate_series(1,20000) g`, [foreign]);
    await db.query("ANALYZE meta_adset_daily");
    const coverage = (account: string | null, start = "2026-01-01", end = "2026-01-03") => getMetaAdSetDailyCoverage({ businessId: business, providerAccountId: account, startDate: start, endDate: end });
    const pooled = await coverage(null);
    assert.deepEqual(pooled, { completed_days: 2, first_completed_date: "2026-01-01", ready_through_date: "2026-01-03", latest_updated_at: "2026-01-12T00:00:00.000Z", total_rows: 3 });
    const end = new Date("2026-01-03T00:00:00Z"), start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 760);
    const [planRow] = await db.query("EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) " + coverageQueries[0]!,
      [business, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), null]);
    const nodes: Record<string, unknown>[] = [];
    function inspect(node: Record<string, unknown>) {
      nodes.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) inspect(child);
    }
    inspect(planRow!["QUERY PLAN"][0].Plan);
    assert(nodes.some((node) => node["Function Name"] === "generate_series" && node["Actual Rows"] === 761));
    assert(nodes.some((node) => /Index/.test(String(node["Node Type"])) &&
      /business_id/.test(String(node["Index Cond"])) && /date.*day_offset/.test(String(node["Index Cond"]))));
    assert(!nodes.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "meta_adset_daily"));
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

    await db.query(`ALTER TABLE meta_sync_partitions ADD COLUMN id uuid DEFAULT gen_random_uuid();
      CREATE UNIQUE INDEX ON meta_sync_partitions(id);
      CREATE TEMP TABLE meta_sync_checkpoints(partition_id uuid,phase text,status text,checkpoint_scope text) ON COMMIT DROP;
      CREATE INDEX ON meta_sync_checkpoints(partition_id,checkpoint_scope);
      CREATE TEMP TABLE meta_breakdown_daily(business_id text,provider_account_id text,date date,breakdown_type text,truth_state text) ON COMMIT DROP;
      CREATE INDEX ON meta_breakdown_daily(business_id,date,breakdown_type);
      CREATE TEMP TABLE meta_raw_snapshots(business_id text,provider_account_id text,endpoint_name text,start_date date,end_date date,status text,partition_id uuid,checkpoint_id uuid,run_id uuid) ON COMMIT DROP;
      CREATE INDEX ON meta_raw_snapshots(business_id,provider_account_id,start_date,end_date);`);
    const partition = "d1810000-0000-4000-8000-000000000001";
    await db.query(`INSERT INTO meta_sync_partitions VALUES
      ($1,'act-a','breakdown_age','2026-01-02','failed','2026-01-10',$2::uuid)`, [business, partition]);
    await db.query(`INSERT INTO meta_sync_checkpoints VALUES
      ($1::uuid,'finalize','succeeded','breakdown:age,gender'),
      ($1::uuid,'finalize','failed','breakdown:country'),
      ($1::uuid,'fetch','succeeded','breakdown:publisher_platform,platform_position,impression_device')`, [partition]);
    await db.query(`INSERT INTO meta_breakdown_daily VALUES
      ($1,'act-a','2026-01-01','age','finalized'),
      ($1,'act-a','2026-01-01','country','provisional'),
      ($2,'act-a','2026-01-05','age','finalized');
      `, [business, foreign]);
    await db.query(`INSERT INTO meta_raw_snapshots VALUES
      ($1,'act-a','breakdown_age','2026-01-01','2026-01-01','fetched',NULL,NULL,NULL),
      ($1,'act-a','breakdown_country','2026-01-01','2026-01-01','fetched',NULL,NULL,NULL),
      ($1,'act-a','breakdown_country','2026-01-03','2026-01-03','fetched',NULL,NULL,NULL),
      ($1,'act-a','breakdown_publisher_platform,platform_position,impression_device','2026-01-02','2026-01-03','fetched',NULL,NULL,NULL),
      ($1,'act-b','breakdown_age','2026-01-05','2026-01-05','fetched',NULL,NULL,NULL),
      ($1,'act-a','breakdown_country','2026-01-04','2026-01-04','fetched',$3::uuid,NULL,NULL),
      ($1,'act-a','breakdown_country','2026-01-04','2026-01-04','partial',NULL,NULL,NULL),
      ($1,'act-a','breakdown_country','2026-01-04','2026-01-10','fetched',NULL,NULL,NULL),
      ($2,'act-a','breakdown_country','2026-01-05','2026-01-05','fetched',NULL,NULL,NULL)`, [business, foreign, partition]);
    await db.query(`INSERT INTO meta_breakdown_daily
      SELECT $1,'decoy','2026-01-01'::date+(g%30),'age','finalized' FROM generate_series(1,20000) g`, [foreign]);
    await db.query("ANALYZE meta_breakdown_daily");
    const endpoints = ["breakdown_age", "breakdown_country", "breakdown_publisher_platform,platform_position,impression_device", "unmapped"];
    const readBreakdown = (account: string | null, from = "2026-01-01", through = "2026-01-05") =>
      getMetaBreakdownDailyCoverageByEndpoint({ businessId: business, providerAccountId: account, endpointNames: [...endpoints, endpoints[0]!], startDate: from, endDate: through });
    const aggregate = (count: number, first: string | null, last: string | null) =>
      ({ completed_days: count, first_completed_date: first, ready_through_date: last });
    const none = aggregate(0, null, null);
    const allBreakdowns = await readBreakdown(null);
    assert.deepEqual(allBreakdowns.get(endpoints[0]!), aggregate(3, "2026-01-01", "2026-01-05"));
    assert.deepEqual(allBreakdowns.get(endpoints[1]!), aggregate(2, "2026-01-01", "2026-01-03"));
    assert.deepEqual(allBreakdowns.get(endpoints[2]!), aggregate(1, "2026-01-02", "2026-01-02"));
    assert.deepEqual(allBreakdowns.get("unmapped"), none);
    assert.deepEqual((await readBreakdown("act-a")).get(endpoints[0]!), aggregate(2, "2026-01-01", "2026-01-02"));
    const accountB = await readBreakdown("act-b");
    assert.deepEqual(accountB.get(endpoints[0]!), aggregate(1, "2026-01-05", "2026-01-05"));
    assert.deepEqual(accountB.get(endpoints[1]!), none);
    assert.deepEqual([...(await readBreakdown("missing")).values()], endpoints.map(() => none));
    const singleDay = await readBreakdown(null, "2026-01-03", "2026-01-03");
    assert.deepEqual(singleDay.get(endpoints[1]!), aggregate(1, "2026-01-03", "2026-01-03"));
    assert.deepEqual(singleDay.get(endpoints[2]!), none); // Raw windows witness their start day only.
    for (const [from, through] of [["2026-01-20", "2026-01-20"], ["2026-01-05", "2026-01-01"]]) {
      assert.deepEqual([...(await readBreakdown(null, from, through)).values()], endpoints.map(() => none));
    }
    const [breakdownPlanRow] = await db.query("EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) " + breakdownQueries[0]!,
      [endpoints.slice(0, 3), ["age", "country", "placement"], ["breakdown:age,gender", "breakdown:country", "breakdown:publisher_platform,platform_position,impression_device"], business, null, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]);
    const breakdownNodes: Record<string, unknown>[] = [];
    collect(breakdownPlanRow!["QUERY PLAN"][0].Plan, breakdownNodes);
    assert(breakdownNodes.some((node) => /Index/.test(String(node["Node Type"])) &&
      /business_id/.test(String(node["Index Cond"])) && /date.*day_offset/.test(String(node["Index Cond"]))));
    assert(!breakdownNodes.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "meta_breakdown_daily"));
    // Pinned calls above really used the same temporary fixture connection.
    assert.equal((await getDb().query("SELECT COUNT(*)::int n FROM meta_adset_daily WHERE business_id=$1", [business]))[0]!.n, 3);

    // Count actual scalar evaluations in the production metadata statement.
    // The wrapper only exists on this owned fixture; it returns the real size.
    await db.query(`CREATE TEMP TABLE system_capacity_snapshots(id bigint,source text,sampled_at timestamptz,payload jsonb) ON COMMIT DROP;
      CREATE TEMP SEQUENCE capacity_size_calls;
      CREATE FUNCTION pg_temp.count_database_size(name) RETURNS bigint VOLATILE LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('pg_temp.capacity_size_calls'); RETURN pg_database_size($1); END $$`);
    assert.equal(capacity[0]!.split("pg_database_size(current_database())").length, 2);
    const countedSql = capacity[0]!.replace("pg_database_size(current_database())", "pg_temp.count_database_size(current_database())");
    const measuredRows = await db.query(countedSql, [[...FENCED_TABLES], PHYSICAL_TELEMETRY_SOURCE]);
    assert.equal(measuredRows.length, FENCED_TABLES.length);
    assert.deepEqual(new Set(measuredRows.map((row) => row.table_name)), new Set(FENCED_TABLES));
    assert.equal(new Set(measuredRows.map((row) => row.database_bytes)).size, 1);
    assert.equal((await db.query("SELECT last_value::int n FROM pg_temp.capacity_size_calls"))[0]!.n, 1,
      "the global database size must be measured once, not once for each fenced table");
    assert(measuredRows.every((row) => row.capacity_id === null && row.capacity_payload === null),
      "missing physical telemetry must remain missing in every metadata row");
  } });
  console.log("[meta-status-api-readers] PASS actual SQL: native/legacy competing-date bounds, ties, null/absent native dates, dual ownership, historical account ambiguity, ordered metadata index/backfills, indexed anomaly kind with null legacy/window/scope/owner parity, exact daily coverage, point breakdown witnesses/checkpoints/legacy raw, 761-day bounds and partition semantics");
}
