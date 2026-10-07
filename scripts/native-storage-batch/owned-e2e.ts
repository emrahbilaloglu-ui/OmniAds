import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { buildNativeHistoricalCatalogRouting, NativeHistoricalCatalogRouter } from "../../lib/creative-decision-engine/native-historical-catalog-routing";
import { persistLocalNativeHistoricalRouting, readLocalNativeHistoricalMetadata } from "../../lib/creative-decision-engine/native-historical-catalog-routing-store";
import { collectWholeOriginal, readCaptureMetadata, verifyCopies, type UnitConfig } from "./capture";
import { sealCompressedNativeHistoricalArchive, NATIVE_HISTORICAL_COMPRESSED_CATALOG_CONTRACT } from "../../lib/creative-decision-engine/native-historical-archive";
import { persistLocalNativeArchive } from "../../lib/creative-decision-engine/native-historical-local-store";
import { BatchRefusal, safeError, sha256, writeExclusive } from "./common";
import { computeSourcePack, PINNED_LIBRARY_FILES, REPO_ROOT, TSX_LOADER } from "./source-pack";
import { databaseUrl, hostPaths, OwnedHostBatchBackend, type OwnedHostConfig } from "./backend";
import { FileBatchJournal, readJournal } from "./journal";
import { verifyHttpProof } from "./http-proof";
import { BOOTSTRAP_SOURCE, buildStageBundle } from "./production-transport";
import { addObservedProductionReferenceIndex, seedCalibration, seedGeneration, seedTenant } from "./owned-fixture";

/** OWNED end-to-end: two fresh PostgreSQL 16 clusters (unix socket only, no
 * TCP), real run-migrations full DDL, actual-producer generations for a NEW
 * random tenant, then the real CLI entrypoint for plan/execute/status plus
 * the veto scenarios. No production host, SSH, provider or network. */
const PG = "/opt/homebrew/opt/postgresql@16/bin";
// macOS postmaster refuses to start without a valid LC_ALL ("became multithreaded").
const PG_ENV: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" };
const CLI = join(REPO_ROOT, "scripts/native-storage-batch/cli.ts");
const OUT = process.env.NSB_RESULT_DIR ?? "";
const PRIVATE_BASE = "/Users/harmelek/.codex/private";
const hex = randomBytes(6).toString("hex"), STATE = `${PRIVATE_BASE}/nsb-owned-${hex}`;
const P = hostPaths(STATE);
const commands: Record<string, unknown>[] = [], checks: Record<string, unknown> = {};
let step = "init";
const today = new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const purpose = () => randomBytes(6).toString("hex");
const cliEnv: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: STATE, TSX_TSCONFIG_PATH: join(REPO_ROOT, "tsconfig.json") };

async function cli(name: string, args: string[]) {
  const started = Date.now();
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI, ...args], { cwd: P.web, env: cliEnv, encoding: "utf8", timeout: 40 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  const logDir = join(OUT, "logs");
  await writeExclusive(join(logDir, `${String(commands.length + 1).padStart(2, "0")}-${name}.stdout`), r.stdout || "-", 0o400);
  await writeExclusive(join(logDir, `${String(commands.length + 1).padStart(2, "0")}-${name}.stderr`), r.stderr || "-", 0o400);
  const record = { name, command: ["node", "--import", "node_modules/tsx/dist/loader.mjs", "scripts/native-storage-batch/cli.ts", ...args.map(a => a.startsWith(STATE) ? a.replace(STATE, "$STATE") : a)],
    exitCode: r.status, signal: r.signal, durationMs: Date.now() - started, stdoutSha256: sha256(r.stdout || "-"), stderrSha256: sha256(r.stderr || "-") };
  commands.push(record);
  let json: any = null; try { json = JSON.parse(r.stdout); } catch { /* refusal prints to stderr */ }
  return { exit: r.status, json, stderr: r.stderr };
}
function psql(c: { sock: string; port: number }, db: string, sql: string) {
  return execFileSync(`${PG}/psql`, ["-h", c.sock, "-p", String(c.port), "-U", "nsb_owner", "-d", db, "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], { encoding: "utf8", env: PG_ENV }).trim();
}
async function cluster(name: string, port: number) {
  const data = join(STATE, "pg", name), sock = join(STATE, "pg", `${name}-sock`);
  await mkdir(sock, { mode: 0o700 });
  execFileSync(`${PG}/initdb`, ["-D", data, "-U", "nsb_owner", "--auth=trust", "--encoding=UTF8", "--locale=C", "--no-instructions"], { stdio: "ignore", env: PG_ENV });
  // enable_seqscan=off: the owned tables are tiny, so the cost model would pick
  // seq scans that production-size tables never get. With it off the planner
  // takes any existing index path; a query WITHOUT an index path still plans a
  // Seq Scan and is still vetoed by the hot-table EXPLAIN guard.
  await appendFile(join(data, "postgresql.conf"), `\nlisten_addresses = ''\nunix_socket_directories = '${sock}'\nunix_socket_permissions = 0700\nport = ${port}\nenable_seqscan = off\n`);
  execFileSync(`${PG}/pg_ctl`, ["-D", data, "-l", join(STATE, "pg", `${name}.log`), "-w", "-t", "60", "start"], { stdio: "ignore", env: PG_ENV });
  return { data, sock, port };
}
function migrate(url: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, join(REPO_ROOT, "scripts/run-migrations.ts")], { cwd: P.web, stdio: "ignore",
      env: { ...cliEnv, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, DB_SSL_MODE: "disable", ENABLE_RUNTIME_MIGRATIONS: "1",
        ADSECUTE_EPHEMERAL_DB_SEAM: "1", ENGINE_V3_NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITES_ENABLED: "false" } });
    child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
  });
}
async function connect(c: { sock: string; port: number }, database: string) {
  const db = new Client({ host: c.sock, port: c.port, user: "nsb_owner", database, application_name: "nsb-owned-harness" });
  db.on("error", () => undefined); await db.connect(); return db;
}
async function countsByJob(db: Client) {
  return Object.fromEntries((await db.query(`SELECT job_run_id::text j,count(*)::int n FROM engine_v3_ad_decision_evaluations GROUP BY 1`)).rows.map(r => [r.j, r.n]));
}
const expectRefusal = async (fn: () => Promise<unknown>) => { try { await fn(); return "NO_REFUSAL"; } catch (e) { return safeError(e).code; } };

async function main() {
  assert(OUT.startsWith("/") && !OUT.startsWith(PRIVATE_BASE), "NSB_RESULT_DIR required");
  await mkdir(join(OUT, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(STATE, { mode: 0o700 });
  for (const d of [join(STATE, "pg"), P.archive, P.routing, P.copies, P.keys, P.activation, P.web, P.batches, P.purposes])
    await mkdir(d, { mode: 0o700 });
  step = "clusters";
  const target = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const port = 20000 + randomBytes(2).readUInt16BE() % 9000;
  const source = await cluster("source", port), restore = await cluster("restore", port + 1);
  const srcDb = `nsb_source_${hex}`, tplDb = `nsb_restore_${hex}`;
  psql(source, "postgres", `CREATE DATABASE ${srcDb} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  psql(restore, "postgres", `CREATE DATABASE ${tplDb} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  const migrations = await Promise.all([migrate(databaseUrl("nsb_owner", source.sock, source.port, srcDb)),
    migrate(databaseUrl("nsb_owner", restore.sock, restore.port, tplDb))]);
  assert.deepEqual(migrations, [0, 0], "real run-migrations full DDL");
  checks.fullMigrationsSourceAndRestoreTemplate = true;

  // ---- actual-producer seed: new random tenant, generic counts/contexts ----
  step = "seed";
  let db = await connect(source, srcDb);
  // D150: the actual production (contract_version,input_hash) index, added to this owned sandbox only (not run-migrations).
  checks.addedProductionIndexPrerequisite = await addObservedProductionReferenceIndex(db);
  const t = await seedTenant(db, 2), clock = (d: string, h: number) => `${d}T${String(h).padStart(2, "0")}:00:00.000001Z`;
  const prod: Record<string, string> = {};
  for (const n of [7, 6, 5, 4, 3, 0]) prod[n] = await seedCalibration(db, t, day(n), clock(day(n), 1));
  const g = async (n: number, h: number, perAccount: number[], tag: string, snapshots = false) =>
    seedGeneration(db, t, { date: day(n), clock: clock(day(n), 1), finishedAt: clock(day(n), h), producer: prod[n]!, perAccount, snapshots, tag });
  const LG = await g(7, 2, [5, 0], "legacy"), E1 = await g(7, 3, [23, 18], "e1"), L7 = await g(7, 4, [6, 0], "l7", true);
  const E2 = await g(6, 2, [0, 29], "e2"), VA = await g(6, 3, [11, 0], "va"), OVER = await g(6, 5, [1135, 0], "over");
  const E3 = await g(5, 2, [30, 23], "e3"), VR = await g(5, 3, [9, 0], "vr");
  const E4 = await g(4, 2, [17, 0], "e4"), E5 = await g(4, 3, [0, 13], "e5"), E6 = await g(3, 2, [7, 0], "e6");
  const CUR = await g(0, 2, [4, 0], "current");
  const vaEval = (await db.query("SELECT id::text id,ad_id FROM engine_v3_ad_decision_evaluations WHERE job_run_id=$1 LIMIT 1", [VA.jobRunId])).rows[0];
  await db.query(`INSERT INTO meta_ads_action_log (business_id,ad_id,action,decision_evaluation_id) VALUES ($1,$2,'pause',$3)`, [t.business, vaEval.ad_id, vaEval.id]);
  await db.query(`INSERT INTO engine_v3_job_runs (job_name,business_ref_id,business_id,as_of_date,engine_version,status,finished_at,error_json)
    SELECT job_name,business_ref_id,business_id,$2::date,engine_version,'skipped',now(),jsonb_build_object('metadata',jsonb_build_object('reused_job_run_id',$1::text))
    FROM engine_v3_job_runs WHERE id=$1::uuid`, [VR.jobRunId, day(4)]);
  await db.query("ANALYZE");
  checks.seed = { tenantIsNewRandomUuid: true, generations: { LG: LG.evaluations, E1: E1.evaluations, L7: L7.evaluations, E2: E2.evaluations,
    VA: VA.evaluations, OVER: OVER.evaluations, E3: E3.evaluations, VR: VR.evaluations, E4: E4.evaluations, E5: E5.evaluations, E6: E6.evaluations, CUR: CUR.evaluations },
    contexts: { E1: E1.contexts, E3: E3.contexts } };

  // ---- key, packaged worker, legacy generation (captured by the same collector), baseline root ----
  step = "legacy-and-baseline";
  const keyId = `owned-nsb-${hex}`, key = randomBytes(32);
  await writeExclusive(join(P.keys, `${keyId}.key`), key, 0o400);
  const { buildNativeHistoricalWorker } = await import(pathToFileURL(join(REPO_ROOT, "scripts/build-native-historical-worker.mjs")).href);
  await buildNativeHistoricalWorker(REPO_ROOT, join(REPO_ROOT, "lib/creative-decision-engine/native-historical-archive-worker.ts"), join(P.web, ".native-historical-worker"));
  const pack = await computeSourcePack(target);
  const legacyCollected = await collectWholeOriginal(db, { generation: { businessId: t.business, jobRunId: LG.jobRunId, asOfDate: day(7),
    engineVersion: (await db.query("SELECT engine_version FROM engine_v3_job_runs WHERE id=$1", [LG.jobRunId])).rows[0].engine_version },
    expectedEvaluations: LG.evaluations, expectedContexts: 1, sourceRevision: target, consumerInventorySha256: pack.sourceManifestSha256 });
  // Legacy = a small whole-original v2 catalog (production's legacy is a 2100 B v2 catalog; a v3 leaf with its coverage root exceeds the 16 KiB legacy bound).
  const legacySealed = sealCompressedNativeHistoricalArchive(legacyCollected.bundle, { manifestHash: legacyCollected.manifestHash,
    schemaHash: legacyCollected.schemaHash, generation: legacyCollected.config.generation }, keyId, key);
  const legacyEntry = await persistLocalNativeArchive(P.archive, legacySealed.bytes, legacySealed.trust);
  const legacy = Buffer.from(JSON.stringify({ contract: NATIVE_HISTORICAL_COMPRESSED_CATALOG_CONTRACT, entries: [legacyEntry] }));
  const legacyMeta = { leafSha256: sha256(legacy) };
  await writeExclusive(P.legacyCatalog, legacy, 0o400);
  checks.legacyCatalogBytes = legacy.length;
  const baseline = buildNativeHistoricalCatalogRouting({ legacy: { content: legacy, sha256: legacyMeta.leafSha256 }, leaves: [] });
  await persistLocalNativeHistoricalRouting(P.routing, baseline);
  await writeExclusive(join(P.activation, "0001.json"), JSON.stringify({ contract: "native-storage-root-activation.v1", purpose: "baseline",
    rootSha256: baseline.root.sha256, previousRootSha256: null, imageRevision: target, activatedAt: new Date().toISOString() }));
  const dbBytes = Number((await db.query("SELECT pg_database_size(current_database())::text n")).rows[0].n);
  const before = await countsByJob(db);
  await db.end();
  // Exceeded ONLY on the database budget (same shape as production G0): 1 MiB below the measured size.
  const host: OwnedHostConfig = { contract: "native-storage-owned-host.v1", mode: "owned", stateRoot: STATE, role: "nsb_owner",
    source: { socketDirectory: source.sock, port: source.port, database: srcDb },
    restore: { socketDirectory: restore.sock, port: restore.port, template: tplDb }, pgDataDirectory: source.data,
    databaseBudgetBytes: dbBytes - 1024 * 1024, knownApplicationNames: [], keyId, legacySha256: legacyMeta.leafSha256 };
  const hostFile = join(STATE, "host.json");
  await writeExclusive(hostFile, JSON.stringify(host), 0o400);
  const review = join(STATE, "owned-review.md");
  await writeExclusive(review, `# OWNED_FIXTURE_REVIEW (owned e2e only; not a human or production review)\nsourceManifestSha256: ${pack.sourceManifestSha256}\nverdict: APPROVE_EXECUTION\n`, 0o400);
  const otherReview = join(STATE, "other-manifest-review.md"), rcReview = join(STATE, "request-changes-review.md");
  await writeExclusive(otherReview, `# OWNED_FIXTURE_REVIEW\nsourceManifestSha256: ${sha256("another-pack")}\nverdict: APPROVE_EXECUTION\n`, 0o400);
  await writeExclusive(rcReview, `# OWNED_FIXTURE_REVIEW\nsourceManifestSha256: ${pack.sourceManifestSha256}\nverdict: REQUEST_CHANGES\n`, 0o400);
  const cutoff = new Date().toISOString();

  // ---- default prepare: no DB/host/network ----
  step = "cli-scenarios";
  const prep = await cli("prepare-default", []);
  checks.defaultPrepare = { exit: prep.exit, productionAccess: prep.json?.productionAccess, databaseAccess: prep.json?.databaseAccess,
    sourceManifestMatches: prep.json?.sourceManifestSha256 === pack.sourceManifestSha256 };
  // ---- source-specific review gate ----
  const r1 = await cli("plan-review-other-manifest", ["plan", "--host", hostFile, "--purpose", purpose(), "--cutoff", cutoff, "--limit", "32", "--review", otherReview]);
  const r2 = await cli("plan-review-request-changes", ["plan", "--host", hostFile, "--purpose", purpose(), "--cutoff", cutoff, "--limit", "32", "--review", rcReview]);
  checks.sourceReviewGate = { otherManifest: [r1.exit, JSON.parse(r1.stderr.split("\n")[0]!).code], requestChanges: [r2.exit, JSON.parse(r2.stderr.split("\n")[0]!).code] };

  // ---- P1: real batch over 3 eligible generations ----
  const p1 = purpose();
  const plan1 = await cli("p1-plan", ["plan", "--host", hostFile, "--purpose", p1, "--cutoff", cutoff, "--limit", "32", "--review", review, "--max-units", "3"]);
  assert.equal(plan1.exit, 0, "P1 plan");
  const p1Jobs = plan1.json.units.map((u: { jobRunId: string }) => u.jobRunId);
  checks.p1Plan = { units: plan1.json.units.map((u: any) => ({ evaluations: u.evaluations, contexts: u.contexts })),
    expectedSet: [E1.jobRunId, E2.jobRunId, E3.jobRunId].every(j => p1Jobs.includes(j)) && p1Jobs.length === 3,
    vetoes: plan1.json.vetoes.map((v: any) => v.code).sort() };
  const sel = await cli("select-metadata-only", ["select", "--host", hostFile, "--cutoff", cutoff, "--limit", "32"]);
  checks.selectMetadataOnly = { exit: sel.exit, evaluationRowsRead: sel.json?.evaluationRowsRead, candidates: sel.json?.candidates?.length,
    currentDayExcluded: !sel.json?.candidates?.some((c: any) => c.generation.jobRunId === CUR.jobRunId),
    overCapRefusal: sel.json?.candidates?.find((c: any) => c.generation.jobRunId === OVER.jobRunId)?.metadataVeto };
  const prodPrep = await cli("prepare-plan-owned-review-as-production", ["prepare", "--plan", join(P.batches, p1, "plan.json"), "--review", review]);
  checks.ownedReviewRefusedForProduction = prodPrep.json?.review?.refused;
  const exec1 = await cli("p1-execute", ["execute", "--host", hostFile, "--purpose", p1, "--review", review]);
  checks.p1Execute = { exit: exec1.exit, result: exec1.json };
  const status1 = await cli("p1-status", ["status", "--host", hostFile, "--purpose", p1]);
  checks.p1Status = { exit: status1.exit, finished: status1.json?.finished, unacknowledgedIntent: status1.json?.unacknowledgedIntent,
    acknowledgedStages: status1.json?.acknowledged?.map((a: any) => a.stage) };
  db = await connect(source, srcDb);
  const after1 = await countsByJob(db);
  checks.p1Database = { retiredAbsent: p1Jobs.every((j: string) => !after1[j]),
    othersUnchanged: Object.keys(before).filter(j => !p1Jobs.includes(j)).every(j => before[j] === after1[j]),
    jobReceiptsRetained: Number((await db.query("SELECT count(*)::int n FROM engine_v3_job_runs WHERE id=ANY($1::uuid[])", [p1Jobs])).rows[0].n) === 3,
    l7SnapshotsRetained: Number((await db.query("SELECT count(*)::int n FROM engine_v3_ad_decision_snapshots_daily WHERE job_run_id=$1", [L7.jobRunId])).rows[0].n) === L7.evaluations };
  await db.end();

  // ---- P2: source drift between freeze and capture → status-only, nothing removed ----
  const p2 = purpose();
  const plan2 = await cli("p2-plan", ["plan", "--host", hostFile, "--purpose", p2, "--cutoff", cutoff, "--limit", "32", "--review", review, "--max-units", "1", "--cursor", `${plan1.json.nextCursor.asOfDate}:${plan1.json.nextCursor.jobRunId}`]);
  const x = plan2.json.units[0].jobRunId;
  db = await connect(source, srcDb);
  await db.query("UPDATE engine_v3_job_runs SET updated_at=updated_at+interval '1 microsecond' WHERE id=$1", [x]);
  await db.end();
  const exec2 = await cli("p2-execute-drift", ["execute", "--host", hostFile, "--purpose", p2, "--review", review]);
  const status2 = await cli("p2-status", ["status", "--host", hostFile, "--purpose", p2]);
  db = await connect(source, srcDb);
  checks.p2Drift = { exit: exec2.exit, reason: exec2.json?.reason, stage: exec2.json?.stage, statusReadOnlyRequired: exec2.json?.statusReadOnlyRequired,
    unacknowledged: status2.json?.unacknowledgedIntent?.stage, rowsIntact: Number((await countsByJob(db))[x]) === before[x] };
  await db.end();

  // ---- P3: lost reply after the COMMIT challenge → ambiguous, status-only, never retried ----
  const p3 = purpose();
  const plan3 = await cli("p3-plan", ["plan", "--host", hostFile, "--purpose", p3, "--cutoff", cutoff, "--limit", "32", "--review", review, "--max-units", "1", "--cursor", `${plan2.json.nextCursor.asOfDate}:${plan2.json.nextCursor.jobRunId}`]);
  const y = plan3.json.units[0].jobRunId;
  const exec3 = await cli("p3-execute-drop-commit-ack", ["execute", "--host", hostFile, "--purpose", p3, "--review", review, "--owned-fault", `drop-commit-ack:${y}`]);
  const status3 = await cli("p3-status-recover-read-only", ["status", "--host", hostFile, "--purpose", p3]);
  const again3 = await cli("p3-execute-again", ["execute", "--host", hostFile, "--purpose", p3, "--review", review]);
  checks.p3Ambiguous = { exit: exec3.exit, reason: exec3.json?.reason, statusReadOnlyRequired: exec3.json?.statusReadOnlyRequired,
    status: status3.json?.ambiguousUnit, retryPerformed: status3.json?.retryPerformed,
    secondExecute: [again3.exit, JSON.parse(again3.stderr.split("\n")[0] || "{}").code] };

  // ---- actual-table FK veto, current-day veto ----
  db = await connect(source, srcDb);
  await db.query("CREATE TABLE nsb_unexpected_child (id uuid PRIMARY KEY, evaluation_id uuid REFERENCES engine_v3_ad_decision_evaluations(id))");
  await db.end();
  const fkPlan = await cli("fk-veto-plan", ["plan", "--host", hostFile, "--purpose", purpose(), "--cutoff", cutoff, "--limit", "32", "--review", review, "--max-units", "1", "--cursor", `${plan3.json.nextCursor.asOfDate}:${plan3.json.nextCursor.jobRunId}`]);
  db = await connect(source, srcDb);
  await db.query("DROP TABLE nsb_unexpected_child");
  const curGen = { businessId: t.business, jobRunId: CUR.jobRunId, asOfDate: day(0),
    engineVersion: (await db.query("SELECT engine_version FROM engine_v3_job_runs WHERE id=$1", [CUR.jobRunId])).rows[0].engine_version };
  await db.end();
  const probe = new OwnedHostBatchBackend(host, { purpose: "000000000000", targetRevision: target, expectedDatabaseBudgetBytes: host.databaseBudgetBytes } as never, review, null);
  checks.actualTableFkVeto = { exit: fkPlan.exit, vetoes: fkPlan.json?.vetoes?.map((v: any) => v.code) };
  checks.currentDayVeto = await expectRefusal(() => probe.child({ op: "freeze", capture: { generation: curGen, expectedEvaluations: CUR.evaluations,
    expectedContexts: 1, sourceRevision: target, consumerInventorySha256: pack.sourceManifestSha256 } }, { database: "source" }));

  // ---- P4 plan; P5 = same unit, source changed after review → refused before any intent ----
  const p4 = purpose();
  const plan4 = await cli("p4-plan", ["plan", "--host", hostFile, "--purpose", p4, "--cutoff", cutoff, "--limit", "32", "--review", review, "--max-units", "1", "--cursor", `${plan3.json.nextCursor.asOfDate}:${plan3.json.nextCursor.jobRunId}`]);
  const p5 = purpose(), bogus = sha256("source-changed-after-review"), p5Dir = join(P.batches, p5);
  await mkdir(join(p5Dir, "units"), { recursive: true, mode: 0o700 });
  const p4Plan = JSON.parse(await readFile(join(P.batches, p4, "plan.json"), "utf8"));
  for (const u of p4Plan.units) await writeExclusive(join(p5Dir, "units", `${u.generation.jobRunId}.config.json`), await readFile(join(P.batches, p4, "units", `${u.generation.jobRunId}.config.json`)));
  const bogusReview = join(STATE, "bogus-manifest-review.md");
  await writeExclusive(bogusReview, `# OWNED_FIXTURE_REVIEW\nsourceManifestSha256: ${bogus}\nverdict: APPROVE_EXECUTION\n`, 0o400);
  await writeExclusive(join(p5Dir, "plan.json"), JSON.stringify({ ...p4Plan, purpose: p5, sourceManifestSha256: bogus,
    actualSourceReviewSha256: sha256(await readFile(bogusReview)) }));
  const exec5 = await cli("p5-execute-source-unknown", ["execute", "--host", hostFile, "--purpose", p5, "--review", bogusReview]);
  checks.sourceUnknownAfterReview = { exit: exec5.exit, reason: exec5.json?.reason, statusReadOnlyRequired: exec5.json?.statusReadOnlyRequired };
  // P4 runs in external-proof mode: it must PAUSE before the first retire (no intent), then resume.
  const exec4 = await cli("p4-execute-external-proof-pause", ["execute", "--host", hostFile, "--purpose", p4, "--review", review, "--http-proof", "external-file"]);
  const e6 = p4Plan.units[0].generation.jobRunId;
  const pauseRecord = await readFile(join(P.batches, p4, "http-proof", `PAUSE-${e6}.json`), "utf8").then(t => JSON.parse(t), () => null);
  const status4 = await cli("p4-status-paused", ["status", "--host", hostFile, "--purpose", p4]);
  const proof4 = await cli("p4-owned-http-proof", ["http-proof", "--host", hostFile, "--purpose", p4, "--unit", e6]);
  const resume4 = await cli("p4-resume", ["resume", "--host", hostFile, "--purpose", p4, "--review", review, "--http-proof", "external-file"]);
  const resume4again = await cli("p4-resume-after-finish", ["resume", "--host", hostFile, "--purpose", p4, "--review", review, "--http-proof", "external-file"]);
  const resume3 = await cli("p3-resume-ambiguous-refused", ["resume", "--host", hostFile, "--purpose", p3, "--review", review]);
  checks.p4PauseResume = { pauseExit: exec4.exit, pauseReason: exec4.json?.reason, pauseStage: exec4.json?.stage,
    pauseStatusReadOnlyRequired: exec4.json?.statusReadOnlyRequired, pauseRecordRequests: pauseRecord?.requests?.length ?? 0,
    pausedUnacknowledgedIntent: status4.json?.unacknowledgedIntent, httpProofExit: proof4.exit, httpProofTransport: proof4.json?.transport,
    resumeExit: resume4.exit, resumeReason: resume4.json?.reason, retired: resume4.json?.retiredOriginalJobs,
    resumeAfterSuccess: [resume4again.exit, resume4again.json?.reason ?? JSON.parse(resume4again.stderr.split("\n")[0] || "{}").code],
    ambiguousResume: [resume3.exit, resume3.json?.reason ?? JSON.parse(resume3.stderr.split("\n")[0] || "{}").code] };
  const proofDir = join(P.batches, p4, "http-proof", e6), p4Unit = p4Plan.units[0], p4Config = JSON.parse(await readFile(join(P.batches, p4, "units", `${e6}.config.json`), "utf8"));
  const p4Capture = JSON.parse(await readFile(join(P.batches, p4, "units", e6, "capture.json"), "utf8"));
  const proofActivation = JSON.parse(await readFile(join(P.activation, (await readdir(P.activation)).filter(n => /^\d{4}\.json$/.test(n)).sort().at(-1)!), "utf8"));
  const expectProof = { purpose: p4, jobRunId: e6, rootSha256: proofActivation.rootSha256, sourceManifestSha256: pack.sourceManifestSha256,
    actualSourceReviewSha256: p4Plan.actualSourceReviewSha256 as string,
    generation: p4Unit.generation, samples: p4Capture.samples, rowSha256: p4Config.evaluationRowSha256, activatedAt: proofActivation.activatedAt,
    nowMs: Date.now(), allowOwnedFixture: true };
  const tamperProof = join(STATE, "tamper-proof"); await cp(proofDir, tamperProof, { recursive: true });
  const bodyFile = join(tamperProof, `${p4Capture.samples[0].evaluationId}.body`);
  await chmod(bodyFile, 0o600); const body = await readFile(bodyFile); body[10] ^= 1; await writeFile(bodyFile, body); await chmod(bodyFile, 0o400);
  checks.httpProofGuards = { genuine: await verifyHttpProof(proofDir, expectProof).then(r => r.matches, e => safeError(e).code),
    tamperedBody: await expectRefusal(() => verifyHttpProof(tamperProof, expectProof)),
    wrongRoot: await expectRefusal(() => verifyHttpProof(proofDir, { ...expectProof, rootSha256: sha256("other-root") })),
    ownedFixtureNotProduction: await expectRefusal(() => verifyHttpProof(proofDir, { ...expectProof, allowOwnedFixture: false })) };

  // ---- root/cipher veto on a real copy; wrong root; final reads through the latest root ----
  const p1Unit = p1Jobs[0], tamper = join(STATE, "tamper-copy");
  await cp(join(P.copies, p1, p1Unit), tamper, { recursive: true });
  const meta = await readCaptureMetadata(tamper), victim = join(tamper, `${meta.parts[0].ciphertextSha256}.bin`);
  await chmod(victim, 0o600); const bytes = await readFile(victim); bytes[bytes.length - 1] ^= 1; await writeFile(victim, bytes); await chmod(victim, 0o400);
  checks.cipherCopyVeto = await expectRefusal(() => verifyCopies(meta, key, P.archive, tamper));
  const { readActivation } = await import("./backend");
  const active = (await readActivation(STATE)).record.rootSha256;
  checks.wrongRootRefused = await expectRefusal(() => new NativeHistoricalCatalogRouter().resolve({ generation: meta.generation,
    evaluationId: meta.parts[0].firstEvaluationId, providerAccountId: "x", adId: "x" }, { rootSha256: sha256("not-the-root"),
    legacySha256: host.legacySha256, readerAssetSha256: "0".repeat(64), directory: P.routing }, (ref, s) => readLocalNativeHistoricalMetadata(P.routing, ref, s)));
  const legacySample = legacyCollected.identities[0]!, retiredConfig = JSON.parse(await readFile(join(P.batches, p1, "units", `${p1Unit}.config.json`), "utf8")) as UnitConfig;
  const retiredCapture = JSON.parse(await readFile(join(P.batches, p1, "units", p1Unit, "capture.json"), "utf8"));
  const finalReads = await probe.child({ op: "fresh-read", keyFile: join(P.keys, `${keyId}.key`), requests: [
    { generation: legacyCollected.config.generation, ...legacySample },
    { generation: retiredConfig.generation, ...retiredCapture.samples[0] }] }, { extraEnv: {
    ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED: "true", ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH: P.legacyCatalog,
    ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256: host.legacySha256, ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID: keyId,
    ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT: "filesystem", ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT: P.archive,
    ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED: "true", ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT: P.routing,
    ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256: active } });
  const p1PlanValue = JSON.parse(await readFile(join(P.batches, p1, "plan.json"), "utf8"));
  const p1Backend = new OwnedHostBatchBackend(host, p1PlanValue, review, null);
  const p1UnitPlan = p1PlanValue.units.find((u: any) => u.generation.jobRunId === p1Unit);
  const finalHttpDir = await p1Backend.captureOwnedHttpProof(p1UnitPlan, active, "final-retired-http-check");
  checks.finalRetiredServedOverHttp = await verifyHttpProof(finalHttpDir, { purpose: p1, jobRunId: p1Unit, rootSha256: active,
    sourceManifestSha256: pack.sourceManifestSha256, actualSourceReviewSha256: p1PlanValue.actualSourceReviewSha256, generation: p1UnitPlan.generation, samples: retiredCapture.samples,
    rowSha256: retiredConfig.evaluationRowSha256, activatedAt: "1970-01-01T00:00:00.000Z", nowMs: Date.now(), allowOwnedFixture: true })
    .then(r => ({ matches: r.matches, requests: r.requests, transport: r.transport, liveRoute: r.liveRoute }), e => safeError(e).code);
  checks.p1RetireHttpProofDirectories = (await readdir(join(P.batches, p1, "http-proof"))).filter(n => /\.owned-\d+$/.test(n)).length;
  checks.finalRootServesLegacyAndRetired = { servingCheck: "reader_function_in_fresh_process_not_http", reads: finalReads.reads.map((r: any) => r.status),
    legacyBytes: finalReads.reads[0].evaluationSha256 === legacyCollected.config.evaluationRowSha256[legacySample.evaluationId],
    retiredBytes: finalReads.reads[1].evaluationSha256 === retiredConfig.evaluationRowSha256[retiredCapture.samples[0].evaluationId] };
  // ---- journal: no intent may be stacked on an unacknowledged one; a forged stack stays visible ----
  const jRoot = join(STATE, "journal-guard"), jPlan = { ...p4Plan, purpose: purpose() };
  await mkdir(jRoot, { mode: 0o700 }); await mkdir(join(jRoot, "purposes"), { mode: 0o700 });
  const jg = new FileBatchJournal(join(jRoot, "journal"), join(jRoot, "purposes"));
  await jg.begin(jPlan); await jg.intent("capture-restore", [e6]);
  const stackedRefusal = await expectRefusal(() => jg.intent("capture-restore", [e6]));
  const second = await readFile(join(jRoot, "journal", "0002-intent.json"));
  await writeExclusive(join(jRoot, "journal", "0003-intent.json"), JSON.stringify({ contract: "finite-native-storage-journal.v1", sequence: 3,
    kind: "intent", at: new Date().toISOString(), previousSha256: sha256(second), stage: "capture-restore", jobRunIds: [e6] }));
  const forged = await readJournal(join(jRoot, "journal"));
  checks.journalGuards = { stackedIntentRefused: stackedRefusal, forgedStackVisible: forged.ambiguousHistory, unacknowledgedIntents: forged.unacknowledgedIntents.length,
    finished: forged.finished, resumeOnForged: await expectRefusal(() => new FileBatchJournal(join(jRoot, "journal"), join(jRoot, "purposes"), "resume").begin(jPlan)) };
  // ---- the source-bound stdin bundle bootstrap, run locally against the OWNED source DB ----
  const bundle = await buildStageBundle(join(STATE, "bundle-probe"));
  const boot = (digest: string, request: Record<string, unknown>) => spawnSync(process.execPath, ["-e", BOOTSTRAP_SOURCE, digest, String(Buffer.byteLength(bundle.source))], {
    cwd: P.web, input: Buffer.concat([Buffer.from(bundle.source), Buffer.from(`${JSON.stringify({ ...request, targetRevision: target })}\n`)]),
    env: { NODE_ENV: "production", PATH: cliEnv.PATH, NSB_HOST_MODE: "owned", NSB_STATE_ROOT: STATE, APP_BUILD_ID: target, DB_SSL_MODE: "disable",
      DATABASE_URL: databaseUrl("nsb_owner", source.sock, source.port, srcDb) }, encoding: "utf8", timeout: 60_000 });
  const lastLine = (r: ReturnType<typeof boot>) => { try { return JSON.parse(r.stdout.trim().split("\n").at(-1)!); } catch { return null; } };
  const bootSpace = boot(bundle.sha256, { op: "space" }), bootEvidence = boot(bundle.sha256, { op: "evidence", databaseBudgetBytes: host.databaseBudgetBytes,
    expectedRole: "nsb_owner", knownApplicationNames: [], jobRunIds: [e6] }), bootWrong = boot(sha256("not-the-bundle"), { op: "space" });
  checks.stdinBundleBootstrap = { bundleBytes: bundle.bytes, bundleInputs: bundle.inputs, space: [bootSpace.status, lastLine(bootSpace)?.type],
    evidence: [bootEvidence.status, lastLine(bootEvidence)?.type, lastLine(bootEvidence)?.value?.business?.reason],
    wrongDigestExit: bootWrong.status };
  checks.allPlanVetoCodes = [...new Set([plan1, plan2, plan3, fkPlan, plan4].flatMap(x => (x.json?.vetoes ?? []).map((v: any) => v.code.split(":")[0])))].sort();
  checks.journals = { p1: (await readJournal(join(P.batches, p1, "journal"))).records, p3: (await readJournal(join(P.batches, p3, "journal"))).records };
  return { source, restore };
}

async function stop(c: { data: string } | undefined) {
  if (!c) return null;
  spawnSync(`${PG}/pg_ctl`, ["-D", c.data, "-m", "immediate", "-w", "stop"], { stdio: "ignore", env: PG_ENV });
  return spawnSync(`${PG}/pg_ctl`, ["-D", c.data, "status"], { stdio: "ignore", env: PG_ENV }).status;
}
(async () => {
  let clusters: { source: { data: string }; restore: { data: string } } | undefined, failure: unknown = null;
  try { clusters = await main(); } catch (e) { failure = e; }
  if (failure) for (const n of ["source", "restore"]) await readFile(join(STATE, "pg", `${n}.log`), "utf8")
    .then(t => writeExclusive(join(OUT, `pg-${n}-log-tail-${hex}.txt`), t.slice(-6000), 0o400)).catch(() => undefined);
  const stopped = [await stop(clusters?.source ?? { data: join(STATE, "pg", "source") }), await stop(clusters?.restore ?? { data: join(STATE, "pg", "restore") })];
  // pg_ctl status 3 = not running (or 4 = no data dir). Remove ONLY this owned state root, only after a confirmed stop.
  const confirmed = stopped.every(s => s === 3 || s === 4);
  if (confirmed && STATE.startsWith(`${PRIVATE_BASE}/nsb-owned-`) && /^[a-f0-9]{12}$/.test(hex)) await rm(STATE, { recursive: true, force: true });
  const receipt = { contract: "native-storage-batch-owned-e2e.v1", stateRoot: "$STATE", stateRootRemoved: confirmed,
    clusterStopStatus: stopped, actualExitCode: failure ? 1 : 0, failedStep: failure ? step : null, failure: failure ? { ...safeError(failure), message: failure instanceof BatchRefusal ? failure.code : String((failure as Error)?.message ?? failure).slice(0, 300) } : null,
    commands, checks, productionAccess: false, providerAuthority: false, keyMaterialInReceipt: false };
  await writeExclusive(join(OUT, `owned-e2e-receipt-${hex}.json`), JSON.stringify(receipt, null, 2), 0o400);
  process.stdout.write(`${JSON.stringify({ actualExitCode: receipt.actualExitCode, receipt: `owned-e2e-receipt-${hex}.json`, failure: receipt.failure })}\n`);
  setTimeout(() => process.exit(receipt.actualExitCode), 200);
})();
