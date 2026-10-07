import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { buildNativeHistoricalCatalogRouting } from "../../lib/creative-decision-engine/native-historical-catalog-routing";
import { persistLocalNativeHistoricalRouting } from "../../lib/creative-decision-engine/native-historical-catalog-routing-store";
import { sealCompressedNativeHistoricalArchive, NATIVE_HISTORICAL_COMPRESSED_CATALOG_CONTRACT } from "../../lib/creative-decision-engine/native-historical-archive";
import { persistLocalNativeArchive } from "../../lib/creative-decision-engine/native-historical-local-store";
import { assessNativeStorageMaintenanceAdmission } from "../../lib/sync/native-storage-maintenance-admission";
import { collectWholeOriginal } from "./capture";
import { EVAL, NATIVE_JOB, safeError, same, sha256, UNIT_TABLES, writeExclusive } from "./common";
import { computeSourcePack, PINNED_LIBRARY_FILES, REPO_ROOT, TSX_LOADER } from "./source-pack";
import { databaseUrl } from "./backend";
import { FileBatchJournal, readJournal } from "./journal";
import { chainFrontier, ownershipStatus } from "./operator-ownership";
import { evidencePath, httpGet, verifyHttpProof, HTTP_PROOF_CONTRACT } from "./http-proof";
import { ARCHIVE_MOUNT, ProductionHostBatchBackend, runActor, STAGE_ENTRY_FILE, type ActorHost, type ActorTransport,
  type ProductionHostConfig } from "./production-transport";
import type { NativeStorageBatchPlan, NativeStorageStageReceipt } from "../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import { prepareProduction, productionExecute, productionPlan, productionPrestate } from "./production-cli";
import { FAKE_CURL, FAKE_DOCKER, FAKE_SYSTEMCTL, FixtureActorTransport, hex64, mkdirs, writeExecutable } from "./production-fixture";
import { seedCalibration, seedGeneration, seedTenant } from "./owned-fixture";

/** PRODUCTION-MECHANICS FIXTURE. The real production-actor.py and the real
 * ProductionHostBatchBackend run through an explicit fixture transport (local
 * python, NON-root) against fake app/db host trees whose "containers" run the
 * real stage bundle on owned PostgreSQL. No SSH, no network host, no
 * production database. Operator revision = HEAD; runtime revision = d60
 * (pinned libraries byte-identical at both). */
const PG = "/opt/homebrew/opt/postgresql@16/bin";
const PG_ENV: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" };
const OUT = process.env.NSB_RESULT_DIR ?? "";
const PRIVATE_BASE = "/Users/harmelek/.codex/private";
const hex = randomBytes(6).toString("hex"), STATE = `${PRIVATE_BASE}/nsb-prodfx-${hex}`;
const OP = join(STATE, "operator"), FX = join(STATE, "fx"), APPFX = join(FX, "app"), DBFX = join(FX, "db");
const APP = join(APPFX, "var/www/adsecute"), ARCHIVE = join(APP, "native-archive");
const RUNTIME = "d60ed58e0f8c512af5bb391c693e99279aaf1840";
const checks: Record<string, unknown> = {};
let step = "init";
const today = new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const purpose = () => randomBytes(6).toString("hex");
const refusal = async (fn: () => Promise<unknown>) => { try { await fn(); return "NO_REFUSAL"; } catch (e) { return safeError(e).code; } };
// D149 cadence ownership observations through the REAL productionPlan/productionExecute entrypoints.
type Cursor = { asOfDate: string; jobRunId: string };
const cmpCursor = (a: Cursor, b: Cursor) => a.asOfDate < b.asOfDate ? -1 : a.asOfDate > b.asOfDate ? 1 : a.jobRunId < b.jobRunId ? -1 : a.jobRunId > b.jobRunId ? 1 : 0;
const cadence: Record<string, unknown> = {};
checks.cadence = cadence;   // bound up front: the receipt keeps every observation even if a later step fails
const examinedRecord = (root: string, p: string) => readFile(join(root, "batches", p, "examined.json"), "utf8").then(JSON.parse, () => null);
const releaseRecord = (root: string, p: string) => readFile(join(root, "control", "released", `${p}.json`), "utf8").then(JSON.parse, () => null);

async function cluster(name: string, base: string, port: number) {
  const data = join(base, "pg", name), sock = join(base, "pg", `${name}-sock`);
  await mkdirs(join(base, "pg"), sock);
  execFileSync(`${PG}/initdb`, ["-D", data, "-U", "nsb_owner", "--auth=trust", "--encoding=UTF8", "--locale=C", "--no-instructions"], { stdio: "ignore", env: PG_ENV });
  await appendFile(join(data, "postgresql.conf"), `\nlisten_addresses = ''\nunix_socket_directories = '${sock}'\nunix_socket_permissions = 0700\nport = ${port}\nenable_seqscan = off\n`);
  execFileSync(`${PG}/pg_ctl`, ["-D", data, "-l", join(base, "pg", `${name}.log`), "-w", "-t", "60", "start"], { stdio: "ignore", env: PG_ENV });
  return { data, sock, port };
}
const psql = (c: { sock: string; port: number }, db: string, sql: string) =>
  execFileSync(`${PG}/psql`, ["-h", c.sock, "-p", String(c.port), "-U", "nsb_owner", "-d", db, "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], { encoding: "utf8", env: PG_ENV }).trim();
function migrate(url: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, join(REPO_ROOT, "scripts/run-migrations.ts")], { cwd: OP, stdio: "ignore",
      env: { NODE_ENV: "production", PATH: PG_ENV.PATH, HOME: OP, TSX_TSCONFIG_PATH: join(REPO_ROOT, "tsconfig.json"), DATABASE_URL: url,
        DATABASE_URL_UNPOOLED: url, DB_SSL_MODE: "disable", ENABLE_RUNTIME_MIGRATIONS: "1", ADSECUTE_EPHEMERAL_DB_SEAM: "1" } });
    child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
  });
}
async function connect(c: { sock: string; port: number }, db: string) {
  const x = new Client({ host: c.sock, port: c.port, user: "nsb_owner", database: db, application_name: "nsb-fixture-harness" });
  x.on("error", () => undefined); await x.connect(); return x;
}

async function main() {
  assert(OUT.startsWith("/") && !OUT.startsWith(PRIVATE_BASE), "NSB_RESULT_DIR required");
  await mkdirs(OUT, STATE, OP, FX, APPFX, DBFX, join(FX, "bin"), APP, ARCHIVE, join(ARCHIVE, "native"), join(ARCHIVE, "native/v2"), join(ARCHIVE, "catalogs"),
    join(DBFX, "var/lib/adsecute-native-storage-batch"), join(OP, "keys"), join(OP, "web"));
  const operatorRevision = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  step = "clusters";
  const port = 22000 + randomBytes(2).readUInt16BE() % 7000;
  const source = await cluster("source", FX, port), restore = await cluster("restore", OP, port + 1);
  const srcDb = `nsb_source_${hex}`, tplDb = `nsb_restore_${hex}`;
  psql(source, "postgres", `CREATE DATABASE ${srcDb} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  psql(restore, "postgres", `CREATE DATABASE ${tplDb} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  const srcUrl = databaseUrl("nsb_owner", source.sock, source.port, srcDb);
  assert.deepEqual(await Promise.all([migrate(srcUrl), migrate(databaseUrl("nsb_owner", restore.sock, restore.port, tplDb))]), [0, 0]);
  checks.fullMigrations = true;

  step = "seed";
  let db = await connect(source, srcDb);
  const t = await seedTenant(db, 2), clock = (d: string, h: number) => `${d}T${String(h).padStart(2, "0")}:00:00.000001Z`;
  const prod: Record<number, string> = {};
  for (const n of [7, 6, 5, 4, 3, 2, 0]) prod[n] = await seedCalibration(db, t, day(n), clock(day(n), 1));
  const g = (n: number, h: number, per: number[], tag: string, snapshots = false) =>
    seedGeneration(db, t, { date: day(n), clock: clock(day(n), 1), finishedAt: clock(day(n), h), producer: prod[n]!, perAccount: per, snapshots, tag });
  const LG = await g(7, 2, [5, 0], "legacy"), E1 = await g(7, 3, [12, 9], "e1"), L7 = await g(7, 4, [6, 0], "l7", true);
  const E2 = await g(6, 2, [0, 15], "e2"), E3 = await g(5, 2, [11, 0], "e3");
  await g(4, 2, [3, 0], "later"); await g(3, 2, [4, 0], "e4"); await g(0, 2, [2, 0], "current");
  // E5 = the second closed unit after rootT's frontier, so the expired capture-only purpose acknowledges TWO captures.
  await g(2, 2, [3, 0], "e5");
  // Archive-engine eligibility headers on the OLDEST closed day, so every from-the-beginning window meets them first:
  // XU = a complete original of a non-current native engine (with its own later same-engine success receipt, row_count 0,
  // never a header) that the prior operator would freeze; XK = a successful receipt with unknown engine metadata;
  // XM = a CURRENT-engine original whose input evidence is absent (must keep failing closed in the existing validation).
  prod[9] = await seedCalibration(db, t, day(9), clock(day(9), 1));
  const LEGACY_ENGINE = "v3-ad-2026-07-18-native-shadow";
  const XU = await seedGeneration(db, t, { date: day(9), clock: clock(day(9), 1), finishedAt: clock(day(9), 2), producer: prod[9]!,
    perAccount: [3, 0], tag: "xu", engineVersion: LEGACY_ENGINE });
  await db.query(`INSERT INTO engine_v3_job_runs (job_name,business_ref_id,business_id,as_of_date,engine_version,status,started_at,finished_at,created_at,row_count)
    VALUES ($1,$2::uuid,$2,$3::date,$4,'success',$5::timestamptz,$6::timestamptz,$5::timestamptz,0)`, [NATIVE_JOB, t.business, day(2), LEGACY_ENGINE, clock(day(2), 1), clock(day(2), 2)]);
  const XK = { jobRunId: (await db.query(`INSERT INTO engine_v3_job_runs (job_name,business_ref_id,business_id,as_of_date,engine_version,status,started_at,finished_at,created_at,row_count)
    VALUES ($1,$2::uuid,$2,$3::date,'','success',$4::timestamptz,$5::timestamptz,$4::timestamptz,2) RETURNING id::text id`, [NATIVE_JOB, t.business, day(9), clock(day(9), 1),
    clock(day(9), 3)])).rows[0].id as string };
  const XM = await g(9, 4, [2, 0], "xm");
  // XL = a successful receipt whose engine text the job DDL accepts (TEXT, no length bound) but is far longer than any
  // persisted veto code may be: it must still record a constant typed veto and never stall owner/frontier recording.
  const XL = { jobRunId: (await db.query(`INSERT INTO engine_v3_job_runs (job_name,business_ref_id,business_id,as_of_date,engine_version,status,started_at,finished_at,created_at,row_count)
    VALUES ($1,$2::uuid,$2,$3::date,$4,'success',$5::timestamptz,$6::timestamptz,$5::timestamptz,2) RETURNING id::text id`, [NATIVE_JOB, t.business, day(9),
    `v3-ad-legacy-${"x".repeat(320)}`, clock(day(9), 1), clock(day(9), 5)])).rows[0].id as string };
  const evidenceRemoved = (await db.query(`DELETE FROM engine_v3_ad_decision_input_evidence i USING (SELECT DISTINCT contract_version,input_hash FROM engine_v3_ad_decision_evaluations
      WHERE job_run_id=$1::uuid) k WHERE i.contract_version=k.contract_version AND i.input_hash=k.input_hash AND NOT EXISTS (SELECT 1 FROM engine_v3_ad_decision_evaluations o
      WHERE o.job_run_id<>$1::uuid AND o.contract_version=k.contract_version AND o.input_hash=k.input_hash)`, [XM.jobRunId])).rowCount;
  assert.ok((evidenceRemoved ?? 0) > 0, "XM_EVIDENCE_NOT_REMOVED");
  await db.query("ANALYZE");
  // An OLD existing sampler row (well over 60 s before any admission).
  await db.query(`INSERT INTO system_capacity_snapshots (source,hostname,sampled_at,payload) VALUES ('db_host_healthcheck','adsecute-db-1',clock_timestamp()-interval '10 minutes',$1::jsonb)`,
    [JSON.stringify({ database: { name: srcDb }, disks: [{ path: "/var/lib/postgresql", totalBytes: 10 ** 12, usedBytes: 10 ** 11, availableBytes: 9 * 10 ** 11 }] })]);
  checks.seed = { E1: E1.evaluations, E2: E2.evaluations, E3: E3.evaluations, L7: L7.evaluations, contextsE1: E1.contexts };

  step = "fake-hosts";
  const key = randomBytes(32), keyId = `fx-held-${hex}`;
  for (const n of ["primary", "recovery"]) await writeExclusive(join(OP, "keys", `${n}.key`), key, 0o400);
  const pack = await computeSourcePack(operatorRevision, REPO_ROOT, RUNTIME);
  const legacyCollected = await collectWholeOriginal(db, { generation: { businessId: t.business, jobRunId: LG.jobRunId, asOfDate: day(7),
    engineVersion: (await db.query("SELECT engine_version FROM engine_v3_job_runs WHERE id=$1", [LG.jobRunId])).rows[0].engine_version },
    expectedEvaluations: LG.evaluations, expectedContexts: 1, sourceRevision: RUNTIME, consumerInventorySha256: pack.sourceManifestSha256 });
  const legacySealed = sealCompressedNativeHistoricalArchive(legacyCollected.bundle, { manifestHash: legacyCollected.manifestHash,
    schemaHash: legacyCollected.schemaHash, generation: legacyCollected.config.generation }, keyId, key);
  const legacyEntry = await persistLocalNativeArchive(ARCHIVE, legacySealed.bytes, legacySealed.trust);
  const legacy = Buffer.from(JSON.stringify({ contract: NATIVE_HISTORICAL_COMPRESSED_CATALOG_CONTRACT, entries: [legacyEntry] })), legacySha = sha256(legacy);
  await writeExclusive(join(ARCHIVE, "catalogs", `${legacySha}.json`), legacy, 0o400);
  const rootDir = join(ARCHIVE, "routing-fixture-legacy"); await mkdirs(rootDir);
  const baseline = buildNativeHistoricalCatalogRouting({ legacy: { content: legacy, sha256: legacySha }, leaves: [] });
  await persistLocalNativeHistoricalRouting(rootDir, baseline);
  const dbBytes = Number((await db.query("SELECT pg_database_size(current_database())::text n")).rows[0].n);
  await db.end();
  const archiveEnv = [`ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED=true`, `ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH=${ARCHIVE_MOUNT}/catalogs/${legacySha}.json`,
    `ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256=${legacySha}`, `ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID=${keyId}`, `ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX=${key.toString("hex")}`,
    `ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT=filesystem`, `ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT=${ARCHIVE_MOUNT}`, `ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED=true`,
    `ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT=${ARCHIVE_MOUNT}/routing-fixture-legacy`, `ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256=${baseline.root.sha256}`].join("\n") + "\n";
  await writeFile(join(APP, ".env.native-archive"), archiveEnv, { mode: 0o600 });
  // The global .env still names the PREVIOUS release (a release exported its tag only inline): the actor must not trust it.
  const PREV = hex64().slice(0, 40);
  for (const n of [".env", ".env.production", "docker-compose.override.yml"])
    await writeFile(join(APP, n), n === ".env" ? `APP_IMAGE_TAG=${PREV}\nAPP_BUILD_ID=${PREV}\n` : `# fixture ${n}\n`, { mode: 0o600 });
  for (const [n, src] of [["docker", FAKE_DOCKER], ["curl", FAKE_CURL], ["systemctl", FAKE_SYSTEMCTL]] as const) await writeExecutable(join(FX, "bin", n), src);
  const bins = { docker: join(FX, "bin/docker"), curl: join(FX, "bin/curl"), systemctl: join(FX, "bin/systemctl") };
  await writeFile(join(APPFX, "fixture.json"), JSON.stringify({ hostname: "adsecute-prod-8gb-ash-1", bin: bins }));
  await writeFile(join(DBFX, "fixture.json"), JSON.stringify({ hostname: "adsecute-db-1", bin: bins }));
  await writeFile(join(DBFX, "sampler.json"), JSON.stringify({ psql: `${PG}/psql`, socket: source.sock, port: source.port, user: "nsb_owner", database: srcDb, dataDirectory: source.data }));
  // Images by id; the local tag table resolves repo:tag as `--pull never` would. The previous
  // release images are already present locally; a foreign image stands for a moved tag.
  const kv = (x: string) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] as [string, string];
  const img = (r: "web" | "worker", rev: string) => ({ Id: `sha256:${hex64()}`, RepoDigests: [`ghcr.io/emrahbilaloglu-ui/omniads-${r}@sha256:${hex64()}`],
    Config: { Env: [`IMAGE_ROLE=${r}`, "NODE_VERSION=20"], Labels: { "org.opencontainers.image.revision": rev, "com.adsecute.release.role": `${r}-runner` } } });
  const images = { web: img("web", RUNTIME), worker: img("worker", RUNTIME), prevWeb: img("web", PREV), prevWorker: img("worker", PREV), foreignWeb: img("web", RUNTIME) };
  const webImage = images.web.Id, workerImage = images.worker.Id;
  const webRef = `ghcr.io/emrahbilaloglu-ui/omniads-web:${RUNTIME}`, workerRef = `ghcr.io/emrahbilaloglu-ui/omniads-worker:${RUNTIME}`;
  const composeBase = { web: { NODE_ENV: "production", DB_SSL_MODE: "disable", DATABASE_URL: srcUrl, CAMPAIGN_CONTEXT_MODE: "automatic",
    ENGINE_V3_NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITES_ENABLED: "true", PORT: "3000", HOSTNAME: "0.0.0.0" },
  worker: { NODE_ENV: "production", DB_SSL_MODE: "disable", DATABASE_URL: srcUrl, CAMPAIGN_CONTEXT_MODE: "automatic", SYNC_WORKER_MODE: "1", SYNC_WORKER_STAGING_IDLE: "" } };
  // Docker: container env = image Config.Env overlaid by the compose environment the release started with.
  const merged = (image: { Config: { Env: string[] } }, env: Record<string, string>) =>
    Object.entries({ ...Object.fromEntries(image.Config.Env.map(kv)), ...env }).map(([k, v]) => `${k}=${v}`);
  const archivePairs = Object.fromEntries(archiveEnv.trim().split("\n").map(kv));
  const role = (r: "web" | "worker", image: typeof images.web, env: Record<string, string>, mounts: unknown[]) => ({ Id: hex64(), Name: `/adsecute-${r}-1`, Image: image.Id,
    State: { Running: true, StartedAt: new Date(Date.now() - 3600_000).toISOString(), Health: { Status: "healthy" } },
    Config: { Env: merged(image, env), Labels: { "com.docker.compose.service": r, "org.opencontainers.image.revision": RUNTIME, "com.adsecute.release.role": `${r}-runner` } },
    Mounts: mounts });
  const state = { appRoot: APP, archiveRoot: ARCHIVE, repoRoot: REPO_ROOT, node: process.execPath, composeBase,
    containers: { web: role("web", images.web, { ...composeBase.web, APP_BUILD_ID: RUNTIME, ...archivePairs }, [{ Type: "bind", Source: ARCHIVE, Destination: ARCHIVE_MOUNT, RW: false }]),
      worker: role("worker", images.worker, { ...composeBase.worker, APP_BUILD_ID: RUNTIME }, []) },
    images: Object.fromEntries(Object.values(images).map(i => [i.Id, i])),
    tags: { [webRef]: images.web.Id, [workerRef]: images.worker.Id, [`ghcr.io/emrahbilaloglu-ui/omniads-web:${PREV}`]: images.prevWeb.Id,
      [`ghcr.io/emrahbilaloglu-ui/omniads-worker:${PREV}`]: images.prevWorker.Id },
    foreignImage: images.foreignWeb.Id, composeUpCalls: 0, faults: {} as Record<string, string> };
  const fakeFile = join(APPFX, "docker-state.json");
  await writeFile(fakeFile, JSON.stringify(state));
  // Read-modify-write of the fake host state (the fake docker itself also writes it).
  const fake = async (fn: (st: any) => void = () => undefined) => { const cur = JSON.parse(await readFile(fakeFile, "utf8")); fn(cur); await writeFile(fakeFile, JSON.stringify(cur)); return cur; };
  const runtimeManifest = join(OP, "runtime-source-manifest.json");
  await writeExclusive(runtimeManifest, JSON.stringify({ files: Object.fromEntries(pack.manifest.entries.filter(e => PINNED_LIBRARY_FILES.includes(e.path)).map(e => [`/app/${e.path}`, e.sha256])) }), 0o400);
  const review = join(OP, "owned-fixture-review.md");
  await writeExclusive(review, `# OWNED_FIXTURE_REVIEW (production-mechanics fixture; not a human or production review)\nsourceManifestSha256: ${pack.sourceManifestSha256}\nverdict: APPROVE_EXECUTION\n`, 0o400);
  const transport = new FixtureActorTransport(FX);
  const manifestSha = sha256(await readFile(runtimeManifest));
  const hostConfig = (prestate: { path: string; sha256: string }): ProductionHostConfig => ({ contract: "native-storage-production-host.v2", mode: "production",
    stateRoot: OP, operatorRevision, runtimeRevision: RUNTIME, prestate, runtimeSourceManifest: { path: runtimeManifest, sha256: manifestSha },
    heldKey: { keyId, sha256: sha256(key), primaryPath: join(OP, "keys/primary.key"), recoveryPath: join(OP, "keys/recovery.key") },
    privateRestore: { socketDirectory: restore.sock, port: restore.port, template: tplDb, role: "nsb_owner" },
    role: "nsb_owner", knownApplicationNames: [], databaseBudgetBytes: dbBytes - 1024 * 1024 });

  step = "prestate";
  const bootHost = join(OP, "host-bootstrap.json");
  await writeExclusive(bootHost, JSON.stringify(hostConfig({ path: runtimeManifest, sha256: manifestSha })), 0o400);
  const pre = await productionPrestate(bootHost, purpose(), runtimeManifest, transport);
  const hostFile = join(OP, "production-host.json");
  await writeExclusive(hostFile, JSON.stringify(hostConfig({ path: pre.file, sha256: pre.sha256 })), 0o400);
  const host = JSON.parse(await readFile(hostFile, "utf8")) as ProductionHostConfig;
  checks.prestate = { distinctRoleImages: pre.distinctRoleImages, prestateSha256: pre.sha256, compose: pre.compose };
  // Global .env stale (previous release) + runtime-only pins: the pinned model IS the running release.
  assert.deepEqual({ pins: pre.compose.pins, global: pre.compose.globalEnvPinKeysEqualRuntime, web: pre.compose.roles.web, worker: pre.compose.roles.worker },
    { pins: { APP_IMAGE_TAG: RUNTIME, APP_BUILD_ID: RUNTIME }, global: { APP_IMAGE_TAG: false, APP_BUILD_ID: false },
      web: { ref: webRef, pinnedRef: true, resolvedImageId: webImage, imageMatches: true, predictedEnvMatches: true, matches: true },
      worker: { ref: workerRef, pinnedRef: true, resolvedImageId: workerImage, imageMatches: true, predictedEnvMatches: true, matches: true } });

  step = "actor-gates";
  // Direct actor sends with deliberately wrong inputs: each refuses BEFORE any intent.
  const gatePlan = { purpose: purpose(), targetRevision: operatorRevision, sourceManifestSha256: pack.sourceManifestSha256,
    actualSourceReviewSha256: sha256(await readFile(review)), expectedDatabaseBudgetBytes: host.databaseBudgetBytes, units: [] } as never;
  const gate = new ProductionHostBatchBackend(host, gatePlan, review, transport);
  const evidenceReq = { request: { op: "evidence", databaseBudgetBytes: host.databaseBudgetBytes, expectedRole: "nsb_owner", knownApplicationNames: [], jobRunIds: [E1.jobRunId] } };
  const send = async (mutate: (p: Record<string, any>) => void, host2: "app" | "db" = "app", op = "db") => {
    const p = await gate.payload(host2, op, "evidence", op === "db" ? evidenceReq : {}); p.sequence = 1; mutate(p);
    const r = await transport.send(host2, p, 60_000); return r.actualExitCode === 0 ? "ACCEPTED" : r.reason;
  };
  const prestate = JSON.parse(await readFile(pre.file, "utf8"));
  checks.actorGates = {
    wrongWorkerImage: await send(p => { p.prestate = { ...prestate, roles: { ...prestate.roles, worker: { ...prestate.roles.worker, imageId: `sha256:${"0".repeat(64)}` } } }; }),
    wrongWebImage: await send(p => { p.prestate = { ...prestate, roles: { ...prestate.roles, web: { ...prestate.roles.web, imageId: workerImage } } }; }),
    runtimeEqualsOperatorRevision: await send(p => { p.runtimeRevision = operatorRevision; }),
    wrongActiveRoot: await send(p => { p.prestate = { ...prestate, activeRoot: { ...prestate.activeRoot, sha256: "a".repeat(64) } }; }),
    closedOpShell: await send(p => { p.op = "shell"; }),
    ownedOnlyRestoreOp: await send(p => { p.request = { op: "restore" }; }),
    keyInPayload: await send(p => { p.request = { ...p.request, heldKeyHex: "0".repeat(64) }; }),
    tamperedBootstrap: await send(p => { p.bootstrapSource = `${p.bootstrapSource} `; }),
    oversizeBundle: await send(p => { p.stageBundleSource = "x".repeat(8 * 1024 * 1024 + 1); p.stageBundleSha256 = sha256(p.stageBundleSource); }),
    notRootWithoutFixture: await runActor(["python3"], await gate.payload("app", "status", "status", {}), 30_000, { PATH: PG_ENV.PATH, NODE_ENV: "production" })
      .then(r => r.reason, e => safeError(e).code),
    distinctImagesAccepted: await send(() => undefined),
  };

  step = "plan";
  const p1 = purpose(), cutoff = new Date().toISOString();
  const plan1 = await productionPlan({ host: hostFile, purpose: p1, cutoff, review, limit: "32", "max-units": "2" }, transport) as any;
  checks.p1Plan = { units: plan1.units?.map((u: any) => u.evaluations), contexts: plan1.units?.map((u: any) => u.contexts), vetoes: plan1.vetoes?.map((v: any) => v.code).sort() };

  step = "cadence-prefix-record";
  // RCW1: the real plan must record its settled, dated candidate prefix; E3 broke the maxUnits loop unsettled.
  const p1Units = (JSON.parse(await readFile(join(OP, "batches", p1, "plan.json"), "utf8")).units as any[])
    .map(u => ({ asOfDate: u.generation.asOfDate as string, jobRunId: u.generation.jobRunId as string })).sort(cmpCursor);
  const p1Last = p1Units.at(-1)!, chainCursor = `${p1Last.asOfDate}:${p1Last.jobRunId}`;
  const ex1 = await examinedRecord(OP, p1);
  cadence.prefixRecord = ex1 === null ? "NO_EXAMINED_PREFIX_RECORD" : {
    throughIsLastSettledUnit: same(ex1.examinedThrough, p1Last), planReportsThrough: same(plan1.examinedThrough, ex1.examinedThrough),
    breakCandidateIsUnsettledE3: same(ex1.breakCandidate, { asOfDate: day(5), jobRunId: E3.jobRunId }),
    orderedDatedPrefix: (ex1.dispositions as any[]).every((d, i, a) => /^\d{4}-\d{2}-\d{2}$/.test(d.candidate.asOfDate) && (i === 0 || cmpCursor(a[i - 1].candidate, d.candidate) < 0)),
    outcomes: (ex1.dispositions as any[]).map(d => d.outcome === "unit" ? "unit" : `${d.code}:${d.permanence}`).sort() };

  step = "archive-engine-eligibility";
  // Mixed headers stay fully dispositioned in the exact chronological prefix; only the current engine may reach a freeze.
  const labelOf = new Map<string, string>([[XU.jobRunId, "unsupported"], [XK.jobRunId, "unknown"], [XM.jobRunId, "supportedMissingEvidence"],
    [XL.jobRunId, "unknownLongEngine"]]);
  const headerOrder = [...labelOf.keys()].sort();
  const appSequence = async () => (await new ProductionHostBatchBackend(host, JSON.parse(await readFile(join(OP, "batches", p1, "plan.json"), "utf8")), review, transport).status()).sequence as any[];
  const frozenFor = (seq: any[], p: string) => new Set(seq.filter(e => e.identity?.purpose === p && e.stage === "plan" && e.identity?.stageOp === "freeze")
    .map(e => e.identity.unitJobRunIds?.[0]));
  const p1Frozen = frozenFor(await appSequence(), p1);
  const bypassDb = await connect(source, srcDb), bypassSql: string[] = [];
  const bypass = await collectWholeOriginal({ query: (sql: string, values?: unknown[]) => { bypassSql.push(sql); return bypassDb.query(sql, values); } } as never,
    { generation: { businessId: t.business, jobRunId: XU.jobRunId, asOfDate: day(9), engineVersion: LEGACY_ENGINE }, expectedEvaluations: 3, expectedContexts: 1,
      sourceRevision: RUNTIME, consumerInventorySha256: pack.sourceManifestSha256 }).then(() => "NO_REFUSAL", e => safeError(e).code);
  await bypassDb.end();
  cadence.engineEligibility = {
    p1: Object.fromEntries((ex1?.dispositions ?? []).filter((d: any) => labelOf.has(d.candidate.jobRunId))
      .map((d: any) => [labelOf.get(d.candidate.jobRunId), d.outcome === "unit" ? "unit" : `${d.code}:${d.permanence}`])),
    headersFirstInChronologicalPrefix: same((ex1?.dispositions ?? []).slice(0, 4).map((d: any) => d.candidate.jobRunId), headerOrder) &&
      (ex1?.dispositions ?? []).slice(0, 4).every((d: any) => d.candidate.asOfDate === day(9)),
    freezeDispatched: Object.fromEntries([...labelOf].map(([id, label]) => [label, p1Frozen.has(id)])),
    directCaptureOfUnsupported: { refusal: bypass, sqlStatements: bypassSql.length, evaluationSqlIssued: bypassSql.some(x => x.includes(EVAL)) },
  };

  step = "cadence-second-owner-while-planned";
  // RCW2: a second real plan while P1 is planned (not executed) on the same private operator root.
  cadence.secondPlanWhileOwnerPlanned = (await refusal(() => productionPlan({ host: hostFile, purpose: purpose(), cutoff, review, limit: "32", "max-units": "1" }, transport))).replace(p1, "P1");

  step = "p1-execute";
  const exec1 = await productionExecute({ host: hostFile, purpose: p1, review }, transport);
  const j1 = await readJournal(join(OP, "batches", p1, "journal"));
  const statusAfter = await new ProductionHostBatchBackend(host, JSON.parse(await readFile(join(OP, "batches", p1, "plan.json"), "utf8")), review, transport).status();
  const fakeState = JSON.parse(await readFile(join(APPFX, "docker-state.json"), "utf8"));
  checks.p1Paused = { exit: exec1.actualExitCode, reason: exec1.reason, stage: exec1.stage, statusReadOnlyRequired: exec1.statusReadOnlyRequired,
    acknowledged: j1.receipts.map(r => r.stage), unacknowledged: j1.unacknowledgedIntents.length,
    webRecreated: fakeState.containers.web.Id !== state.containers.web.Id, workerUnchanged: fakeState.containers.worker.Id === state.containers.worker.Id &&
      fakeState.containers.worker.State.StartedAt === state.containers.worker.State.StartedAt,
    webSameRuntimeImage: fakeState.containers.web.Image === webImage, composeUpCalls: fakeState.composeUpCalls,
    remoteSequence: statusAfter.sequence.map((e: any) => `${e.stage}:${e.op}:${e.receipt?.actualExitCode}`),
    pauseRecords: (await readdir(join(OP, "batches", p1, "http-proof"))).filter(n => n.startsWith("PAUSE-")).length };
  const p1Plan = JSON.parse(await readFile(join(OP, "batches", p1, "plan.json"), "utf8"));
  // Stale global .env + pins: ONE apply recreated web from the SAME runtime image with the new root; worker untouched.
  assert.deepEqual([fakeState.containers.web.Id !== state.containers.web.Id, fakeState.containers.web.Image === webImage,
    fakeState.containers.worker.Id === state.containers.worker.Id, fakeState.composeUpCalls], [true, true, true, 1]);

  step = "cadence-second-owner-while-paused";
  // RCW2: P1 is paused at the authenticated HTTP gate after activation; a second real plan must not start. The probe
  // uses a FRESH prestate (P1 recreated web), so a refusal can only come from ownership, not from a stale role pin.
  const freshHost = async (name: string) => { const pre = await productionPrestate(hostFile, purpose(), runtimeManifest, transport);
    const f = join(OP, `production-host-cadence-${name}.json`); await writeExclusive(f, JSON.stringify(hostConfig({ path: pre.file, sha256: pre.sha256 })), 0o400); return f; };
  const hostPaused = await freshHost("paused");
  cadence.secondPlanWhileOwnerPaused = (await refusal(() => productionPlan({ host: hostPaused, purpose: purpose(), cutoff, review, limit: "32", "max-units": "1" }, transport))).replace(p1, "P1");
  const restoreReceipts = await Promise.all(p1Plan.units.map((u: any) => readFile(join(OP, "batches", p1, "units", u.generation.jobRunId, "restore.json"), "utf8").then(JSON.parse)));
  checks.p1PrivateRestore = restoreReceipts.map((r: any) => ({ parity: r.frozenProofParity, plaintextDropped: r.plaintextRestoreDropped }));
  checks.p1PrivateCopies = await Promise.all(p1Plan.units.map(async (u: any) => (await readdir(join(OP, "copies", p1, u.generation.jobRunId))).sort()));

  step = "remote-sequence";
  // A NEW backend instance that does not restore the sequence cannot reissue a consumed marker.
  const fresh = new ProductionHostBatchBackend(host, p1Plan, review, transport);
  const replay = await fresh.payload("app", "db", "evidence", evidenceReq); replay.sequence = 1;
  checks.consumedSequenceReissue = (await transport.send("app", replay, 60_000)).reason;

  step = "http-proof";
  const activation = JSON.parse(await readFile(join(OP, "batches", p1, "activation.json"), "utf8"));
  for (const u of p1Plan.units) await ownedHttpProof(p1Plan, u, activation.activeRoot, key, legacySha, review);
  const u0 = p1Plan.units[0], cap0 = JSON.parse(await readFile(join(OP, "batches", p1, "units", u0.generation.jobRunId, "capture.json"), "utf8"));
  const cfg0 = JSON.parse(await readFile(join(OP, "batches", p1, "units", `${u0.generation.jobRunId}.config.json`), "utf8"));
  const proofDir = join(OP, "batches", p1, "http-proof", u0.generation.jobRunId), tampered = join(STATE, "tampered-proof");
  await cp(proofDir, tampered, { recursive: true });
  const body = join(tampered, `${cap0.samples[0].evaluationId}.body`); await chmod(body, 0o600);
  const b = await readFile(body); b[20] ^= 1; await writeFile(body, b); await chmod(body, 0o400);
  const expectProof = { purpose: p1, jobRunId: u0.generation.jobRunId, rootSha256: activation.activeRoot.sha256, sourceManifestSha256: p1Plan.sourceManifestSha256,
    actualSourceReviewSha256: p1Plan.actualSourceReviewSha256, generation: u0.generation, samples: cap0.samples, rowSha256: cfg0.evaluationRowSha256,
    activatedAt: activation.finishedAt, nowMs: Date.now(), allowOwnedFixture: true };
  checks.httpProof = { genuine: await verifyHttpProof(proofDir, expectProof).then(r => r.matches, e => safeError(e).code),
    tamperedBody: await refusal(() => verifyHttpProof(tampered, expectProof)),
    wrongReview: await refusal(() => verifyHttpProof(proofDir, { ...expectProof, actualSourceReviewSha256: "b".repeat(64) })),
    productionRequiresChrome: await refusal(() => verifyHttpProof(proofDir, { ...expectProof, allowOwnedFixture: false })) };

  step = "resume-binding";
  checks.resumeBinding = await resumeBindingGuards(host, p1Plan, review, transport, j1.receipts);

  step = "p1-resume";
  const resume1 = await productionExecute({ host: hostFile, purpose: p1, review }, transport, true);
  const j1b = await readJournal(join(OP, "batches", p1, "journal"));
  db = await connect(source, srcDb);
  const present = Number((await db.query("SELECT count(*)::int n FROM engine_v3_ad_decision_evaluations WHERE job_run_id=ANY($1::uuid[])", [p1Plan.units.map((u: any) => u.generation.jobRunId)])).rows[0].n);
  const jobs = Number((await db.query("SELECT count(*)::int n FROM engine_v3_job_runs WHERE id=ANY($1::uuid[])", [p1Plan.units.map((u: any) => u.generation.jobRunId)])).rows[0].n);
  const l7 = Number((await db.query("SELECT count(*)::int n FROM engine_v3_ad_decision_snapshots_daily WHERE job_run_id=$1", [L7.jobRunId])).rows[0].n);
  await db.end();
  checks.p1Resume = { exit: resume1.actualExitCode, reason: resume1.reason, retired: resume1.retiredOriginalJobs.length, finished: j1b.finished,
    resumes: j1b.resumes, evaluationsPresent: present, jobReceiptsRetained: jobs, l7SnapshotsRetained: l7 === L7.evaluations,
    measuredOutcomeFiles: (await readdir(join(OP, "batches", p1))).filter(n => n.startsWith("measured-outcome-")).length };
  // Positive source-identical paused HTTP resume, with the exact-identity verifier: must finish.
  assert.equal(resume1.actualExitCode, 0); assert.equal(j1b.finished, true); assert.equal(resume1.retiredOriginalJobs.length, p1Plan.units.length);

  step = "cadence-cursor-chain";
  // RCW1 chain: after P1's terminal progress, cursor=null (rescan) and a cursor beyond the unsettled E3 (silent skip) refuse.
  cadence.p1ReleaseOutcome = (await releaseRecord(OP, p1))?.outcome ?? "NO_RELEASE_RECORD";
  const hostChain = await freshHost("chain");
  cadence.nullCursorAfterTerminalProgress = await refusal(() => productionPlan({ host: hostChain, purpose: purpose(), cutoff, review, limit: "32", "max-units": "1" }, transport));
  cadence.aheadCursorSkippingUnexamined = await refusal(() => productionPlan({ host: hostChain, purpose: purpose(), cutoff, review, limit: "32", "max-units": "1",
    cursor: `${day(5)}:${E3.jobRunId}` }, transport));

  step = "fresh-capacity";
  const capBackend = new ProductionHostBatchBackend(host, p1Plan, review, transport);
  const admit = async () => { const f = await capBackend.freshEvidence("read-original", [p1Plan.units[0]]);
    return assessNativeStorageMaintenanceAdmission({ ...f, expectedDatabaseBudgetBytes: host.databaseBudgetBytes, nowMs: Date.now() }); };
  const live = await admit();
  await writeFile(join(DBFX, "sampler.json"), JSON.stringify({ ...JSON.parse(await readFile(join(DBFX, "sampler.json"), "utf8")), fault: "noop" }));
  await new Promise(r => setTimeout(r, 62_000));
  const stale = await admit();
  await writeFile(join(DBFX, "sampler.json"), JSON.stringify({ ...JSON.parse(await readFile(join(DBFX, "sampler.json"), "utf8")), fault: "fail" }));
  const failed = await refusal(() => capBackend.freshEvidence("read-original", [p1Plan.units[0]]));
  await writeFile(join(DBFX, "sampler.json"), JSON.stringify({ ...JSON.parse(await readFile(join(DBFX, "sampler.json"), "utf8")), fault: undefined }));
  checks.freshCapacity = { liveAdmitted: live.admitted, liveBusinessReason: live.businessReason, staleIssues: stale.issues, samplerFailure: failed };

  step = "drift";
  // Cipher drift on the finished P1 copies: the copies gate turns false (blocks publish/activate/retire admission).
  const r0 = join(OP, "copies", p1, u0.generation.jobRunId, "recovery"), m0 = cap0.metadata;
  const v0 = join(r0, `${m0.parts[0].ciphertextSha256}.bin`); await chmod(v0, 0o600);
  const vb0 = await readFile(v0); vb0[vb0.length - 1] ^= 1; await writeFile(v0, vb0); await chmod(v0, 0o400);
  const cipherDrift = await new ProductionHostBatchBackend(host, p1Plan, review, transport).freshEvidence("publish-original", [u0]);
  const sourceDrift = await refusal(() => new ProductionHostBatchBackend(host, { ...p1Plan, sourceManifestSha256: "c".repeat(64) }, review, transport).freshEvidence("read-original", [u0]));
  checks.p1Drift = { cipherCopyMismatchBlocksPublish: cipherDrift.evidence.completeOriginalCopiesMatch === false,
    recoveryCopyTampered: sha256(vb0) !== m0.parts[0].ciphertextSha256, sourceDrift };

  step = "compose-binding";
  // Every refusal must come BEFORE intent, archive env write or recreate. Probe: an activate-root for P1's own
  // (already published, already acknowledged) root; with a consistent host it passes the gates and is refused at begin.
  const p1Backend = new ProductionHostBatchBackend(host, p1Plan, review, transport);
  const activation1 = JSON.parse(await readFile(join(OP, "batches", p1, "activation.json"), "utf8"));
  const probe = async (mutate: (p: Record<string, any>) => void = () => undefined) => {
    const p = await p1Backend.payload("app", "activate-root", "activate", { newRoot: activation1.activeRoot, unitJobRunIds: p1Plan.units.map((u: any) => u.generation.jobRunId) });
    p.sequence = (await p1Backend.status()).sequence.length + 1; mutate(p);
    const r = await transport.send("app", p, 60_000); return r.actualExitCode === 0 ? "ACCEPTED" : r.reason;
  };
  const sideEffects = async () => { const f = await fake(); return { env: sha256(await readFile(join(APP, ".env.native-archive"))),
    web: [f.containers.web.Id, f.containers.web.Image, f.containers.web.State.StartedAt], worker: [f.containers.worker.Id, f.containers.worker.State.StartedAt],
    composeUpCalls: f.composeUpCalls, remote: (await p1Backend.status()).sequence.length }; };
  const freshPrestate = () => refusal(() => productionPrestate(hostFile, purpose(), runtimeManifest, transport));
  const before = await sideEffects();
  const consistentControl = await probe();
  // Pinned model resolves to the PREVIOUS release already present (runtime tag moved): no prestate, no intent.
  await fake(st => { st.tags[webRef] = images.prevWeb.Id; });
  const staleWeb = { activate: await probe(), prestate: await freshPrestate() };
  await fake(st => { st.tags[webRef] = images.web.Id; st.tags[workerRef] = images.prevWorker.Id; });
  const workerDrift = { activate: await probe(), prestate: await freshPrestate() };
  await fake(st => { st.tags[workerRef] = images.worker.Id; });
  // The running web was started with an inline value the pinned model does not reproduce.
  const flip = (to: string) => fake(st => { st.containers.web.Config.Env = st.containers.web.Config.Env.map((x: string) => x.startsWith("CAMPAIGN_CONTEXT_MODE=") ? `CAMPAIGN_CONTEXT_MODE=${to}` : x); });
  await flip("manual");
  const driftedEnvSha = (await p1Backend.status()).roles.web.otherEnvSha256;
  const envDrift = { prestate: await freshPrestate(),
    // The actor's own gate, even for a prestate frozen without the CLI check (roles taken from the drifted live web).
    activate: await probe(p => { p.prestate = { ...p.prestate, roles: { ...p.prestate.roles, web: { ...p.prestate.roles.web, otherEnvSha256: driftedEnvSha } } }; }) };
  await flip("automatic");
  const after = await sideEffects();
  checks.composeBinding = { consistentControl, staleWeb, workerDrift, envDrift, noSideEffects: same(before, after) };
  assert.deepEqual(checks.composeBinding, { consistentControl: "STAGE_ALREADY_ACKNOWLEDGED_REMOTE",
    staleWeb: { activate: "COMPOSE_MODEL_IS_NOT_RUNNING_RELEASE:web:image", prestate: "COMPOSE_MODEL_NOT_RUNNING_RELEASE:web" },
    workerDrift: { activate: "COMPOSE_MODEL_IS_NOT_RUNNING_RELEASE:worker:image", prestate: "COMPOSE_MODEL_NOT_RUNNING_RELEASE:worker" },
    envDrift: { prestate: "COMPOSE_MODEL_NOT_RUNNING_RELEASE:web", activate: "COMPOSE_MODEL_IS_NOT_RUNNING_RELEASE:web:env" }, noSideEffects: true });

  step = "p2-activation-lost-reply";
  // Execution of a NEW purpose starts from a FRESH root-frozen prestate (P1's own new web is now the live baseline).
  const pre2 = await productionPrestate(hostFile, purpose(), runtimeManifest, transport);
  const hostFile2 = join(OP, "production-host-p2.json");
  await writeExclusive(hostFile2, JSON.stringify(hostConfig({ path: pre2.file, sha256: pre2.sha256 })), 0o400);
  const p2 = purpose();
  const plan2 = await productionPlan({ host: hostFile2, purpose: p2, cutoff, review, limit: "32", "max-units": "1", cursor: chainCursor }, transport) as any;
  await fake(st => { st.faults = { composeUp: "kill-after-recreate" }; });
  const exec2 = await productionExecute({ host: hostFile2, purpose: p2, review }, transport);
  await fake(st => { st.faults = {}; });
  const resume2 = await refusal(() => productionExecute({ host: hostFile2, purpose: p2, review }, transport, true).then(r => { if (r.actualExitCode) throw new Error(r.reason); }));
  const host2 = JSON.parse(await readFile(hostFile2, "utf8")) as ProductionHostConfig;
  const listing = (await new ProductionHostBatchBackend(host2, JSON.parse(await readFile(join(OP, "batches", p2, "plan.json"), "utf8")), review, transport).status()).sequence;
  checks.p2ActivationLostReply = { planUnits: plan2.units?.length, exit: exec2.actualExitCode, reason: exec2.reason, stage: exec2.stage,
    statusReadOnlyRequired: exec2.statusReadOnlyRequired, resumeRefused: resume2, lastRemote: listing.at(-1) };

  step = "p2-blocked";
  const p2Plan = JSON.parse(await readFile(join(OP, "batches", p2, "plan.json"), "utf8")), u2 = p2Plan.units[0];
  // P2 ended ambiguous: every further P2 call must be refused (status-only), never retried.
  const p2Blocked = await refusal(() => new ProductionHostBatchBackend(host2, p2Plan, review, transport).freshEvidence("publish-original", [u2]));
  checks.p2AmbiguousBlocksFurtherRemoteOps = p2Blocked;

  step = "cadence-second-owner-while-ambiguous";
  // RCW2: P2's activation is unacknowledged (routing unknown): no second owner on this operator root.
  const hostAmbiguous = await freshHost("ambiguous");
  cadence.secondPlanWhileOwnerAmbiguous = (await refusal(() => productionPlan({ host: hostAmbiguous, purpose: purpose(), cutoff, review, limit: "32", "max-units": "1",
    cursor: chainCursor }, transport))).replace(p2, "P2");

  step = "post-apply-drift-no-recovery";
  // The gate passed, then the apply produced a foreign web image / touched the worker: ONE apply, no recovery recreate, status-only.
  // Each drift purpose ends ambiguous (status-only), so each gets its OWN operator root. Every root must contain the
  // private restore socket (OPERATOR_PRIVATE_RESTORE_SCOPE is never relaxed): the ancestors STATE and OP/pg are used.
  const driftRun = async (fault: string, root: string, cursor?: string) => {
    const preX = await productionPrestate(hostFile, purpose(), runtimeManifest, transport), hostX = join(OP, `production-host-${fault}.json`);
    await writeExclusive(hostX, JSON.stringify({ ...hostConfig({ path: preX.file, sha256: preX.sha256 }), stateRoot: root }), 0o400);
    const pX = purpose(), planX = await productionPlan({ host: hostX, purpose: pX, cutoff, review, limit: "32", "max-units": "1", ...(cursor ? { cursor } : {}) }, transport) as any;
    assert.equal(planX.units?.length, 1, `DRIFT_RUN_PLAN:${JSON.stringify(planX.vetoes ?? planX.reason)}`);
    const calls0 = (await fake(st => { st.faults = { composeUp: fault }; })).composeUpCalls;
    const execX = await productionExecute({ host: hostX, purpose: pX, review }, transport);
    const afterX = await fake(st => { st.faults = {}; });
    const kept = (await readdir(join(root, "batches", pX, "remote"))).filter(n => n.endsWith("-activate-activate-root.json"));
    const receipt = JSON.parse(await readFile(join(root, "batches", pX, "remote", kept[0]!), "utf8"));
    return { planUnits: planX.units?.length, exit: execX.actualExitCode, reason: execX.reason, stage: execX.stage, statusReadOnlyRequired: execX.statusReadOnlyRequired,
      composeUpCalls: afterX.composeUpCalls - calls0, recoveryApply: receipt.recoveryApply ?? null, recoveryRefused: receipt.recoveryRefused ?? null };
  };
  const imageDrift = await driftRun("foreign-web-image", STATE);
  // Operator puts the live web back on the runtime image with the env the archive file now names (P3's own root).
  const archiveNow = Object.fromEntries((await readFile(join(APP, ".env.native-archive"), "utf8")).trim().split("\n").map(kv));
  await fake(st => { const w = st.containers.web; w.Image = webImage; w.Config.Env = merged(images.web, { ...composeBase.web, APP_BUILD_ID: RUNTIME, ...archiveNow });
    w.Config.Labels["org.opencontainers.image.revision"] = RUNTIME; w.Id = hex64(); w.State.StartedAt = new Date().toISOString(); });

  step = "cadence-terminal-scan-and-abandon";
  // Root OP/pg (free): empty window and all-veto window are read-only terminal scans; an unexecuted plan is
  // abandoned race-free (consumed marker) and never advances the chain. Commands are resolved dynamically so the
  // baseline run records their absence instead of failing to import.
  const cli: any = await import("./production-cli");
  const rootT = join(OP, "pg"), hostT = join(OP, "production-host-terminal-scan.json");
  const preT = await productionPrestate(hostFile, purpose(), runtimeManifest, transport);
  await writeExclusive(hostT, JSON.stringify({ ...hostConfig({ path: preT.file, sha256: preT.sha256 }), stateRoot: rootT }), 0o400);
  const planT = (p: string, extra: Record<string, string>) => productionPlan({ host: hostT, purpose: p, cutoff, review, limit: "32", "max-units": "1", ...extra }, transport) as Promise<any>;
  const tEmpty = purpose(), emptyScan = await planT(tEmpty, { cutoff: `${day(10)}T00:00:00.000Z` });
  const tVeto = purpose(), vetoScan = await planT(tVeto, { limit: "2" });
  const exVeto = await examinedRecord(rootT, tVeto);
  const frontierT = exVeto?.examinedThrough ? `${exVeto.examinedThrough.asOfDate}:${exVeto.examinedThrough.jobRunId}` : undefined;
  const expectedHead: Record<string, string> = { unsupported: "ARCHIVE_ENGINE_UNSUPPORTED", unknown: "ARCHIVE_ENGINE_METADATA_UNKNOWN", supportedMissingEvidence: "SOURCE_CAPTURE_REFUSED",
    unknownLongEngine: "ARCHIVE_ENGINE_METADATA_UNKNOWN" };
  Object.assign(cadence.engineEligibility as Record<string, unknown>, {
    allVetoWindowIsFirstTwoHeadersWithTypedCodes: same((exVeto?.dispositions ?? []).map((d: any) => d.candidate.jobRunId), headerOrder.slice(0, 2)) &&
      (exVeto?.dispositions ?? []).every((d: any) => d.outcome === "veto" && d.code.split(":")[0] === expectedHead[labelOf.get(d.candidate.jobRunId)!]),
    frontierAdvancedExactlyToSecondHeader: exVeto?.examinedThrough?.jobRunId === headerOrder[1],
    tVetoFreezeOnlySupported: [...frozenFor(await appSequence(), tVeto)].every(id => labelOf.get(id) === "supportedMissingEvidence") });
  const tUnit = purpose(), unitPlan = await planT(tUnit, frontierT ? { cursor: frontierT } : {}).catch(e => ({ refused: safeError(e).code }));
  const abandon = typeof cli.abandonPurpose === "function"
    ? await refusal(() => cli.abandonPurpose({ host: hostT, purpose: tUnit })) : "ABANDON_COMMAND_ABSENT";
  cadence.terminalScanAndAbandon = {
    emptyWindow: { units: emptyScan.units?.length ?? null, terminalScan: emptyScan.terminalScan ?? null, release: (await releaseRecord(rootT, tEmpty))?.outcome ?? null,
      advancesChain: (await releaseRecord(rootT, tEmpty))?.advancesChain ?? null },
    allVetoWindow: { units: vetoScan.units?.length ?? null, terminalScan: vetoScan.terminalScan ?? null, release: (await releaseRecord(rootT, tVeto))?.outcome ?? null,
      advancesChain: (await releaseRecord(rootT, tVeto))?.advancesChain ?? null, examinedSettled: exVeto?.dispositions?.length ?? null },
    nullCursorAfterTerminalScan: await refusal(() => planT(purpose(), {})),
    unitPlanned: unitPlan.units?.length ?? unitPlan.refused ?? null, abandon,
    abandonRelease: (await releaseRecord(rootT, tUnit))?.outcome ?? null, abandonAdvancesChain: (await releaseRecord(rootT, tUnit))?.advancesChain ?? null,
    // Only probed when the abandon actually happened: an un-abandoned plan is never executed here.
    executeAfterAbandon: abandon === "NO_REFUSAL" ? await refusal(() => productionExecute({ host: hostT, purpose: tUnit, review }, transport)) : "NOT_ABANDONED_NOT_EXECUTED",
  };
  step = "cadence-legacy-dispositions";
  // Never-leased legacy purposes in rootT (no owner active): an fb9-shaped lost maintenance ACK over P1's REAL retired units
  // (their frozen configs, the owned source DB), and a 5aa1-shaped pre-dispatch refusal. Dispositions run through the REAL
  // CLI exports; the settlement is a live SELECT-only collection on owned PostgreSQL.
  const lX = purpose(), lY = purpose(), ids1: string[] = p1Plan.units.map((u: any) => u.generation.jobRunId);
  const v1 = (p: string, units: any[]) => ({ ...p1Plan, contract: "finite-native-storage-batch.v1", purpose: p, units });
  const v1Result = (p: string, o: Record<string, unknown>) => ({ contract: "finite-native-storage-batch.v1", purpose: p, actualExitCode: 1, statusReadOnlyRequired: false,
    retiredOriginalJobs: [], providerAuthority: false, physicalBytesReclaimed: 0, sustainableStorageClosed: false, newWebOwnObservationRequired: false, ...o }) as any;
  const xDir = join(rootT, "batches", lX), yDir = join(rootT, "batches", lY);
  await mkdir(join(xDir, "units"), { recursive: true, mode: 0o700 }); await mkdir(yDir, { mode: 0o700 });
  for (const j of ids1) await writeExclusive(join(xDir, "units", `${j}.config.json`), await readFile(join(OP, "batches", p1, "units", `${j}.config.json`)));
  await writeExclusive(join(xDir, "plan.json"), JSON.stringify(v1(lX, p1Plan.units)));
  const jX = new FileBatchJournal(join(xDir, "journal"), join(rootT, "purposes"));
  await jX.begin(v1(lX, p1Plan.units) as any);
  for (const [stage, jobs] of [...ids1.map(j => ["capture-restore", [j]]), ["publish", ids1], ["activate", ids1],
    ...ids1.flatMap(j => [["retire", [j]], ["independent-readback", [j]]]), ["vacuum-main", ids1]] as [any, string[]][]) {
    await jX.intent(stage, jobs);
    await jX.receipt({ purpose: lX, stage, jobRunIds: jobs, actualExitCode: 0, actionAcknowledged: true, independentFullOriginalBytesMatch: true,
      providerAuthority: false, reclaimedBytes: 0, evidenceSha256: sha256(`${lX}:${stage}:${jobs.join(",")}`) });
  }
  await jX.intent("vacuum-toast", ids1);
  await jX.finish(v1Result(lX, { stage: "vacuum-toast", reason: "UNKNOWN_ACK", statusReadOnlyRequired: true, retiredOriginalJobs: ids1 }));
  await writeExclusive(join(yDir, "plan.json"), JSON.stringify(v1(lY, [p1Plan.units[0]])));
  const jY = new FileBatchJournal(join(yDir, "journal"), join(rootT, "purposes"));
  await jY.begin(v1(lY, [p1Plan.units[0]]) as any);
  await jY.finish(v1Result(lY, { stage: "capture-restore", reason: "MAINTENANCE_REFUSED:app_physical_reserve" }));
  const tree = async (dir: string): Promise<string> => sha256(JSON.stringify(await Promise.all((await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)
    .map(async e => [e.name, e.isDirectory() ? await tree(join(dir, e.name)) : sha256(await readFile(join(dir, e.name)))]))));
  const history = async (p: string) => [await tree(join(rootT, "batches", p, "journal")), sha256(await readFile(join(rootT, "purposes", `${p}.json`))),
    sha256(await readFile(join(rootT, "batches", p, "plan.json")))].join(":");
  const historyX = await history(lX), historyY = await history(lY);
  const blocked = await refusal(() => planT(purpose(), frontierT ? { cursor: frontierT } : {}));
  const settle = (pg: { sock: string; port: number }, database: string, user = "nsb_owner") => refusal(() => cli.disposeMaintenanceUnknown({ host: hostT,
    purpose: lX, "pg-host": pg.sock, "pg-port": String(pg.port), "pg-database": database, "pg-user": user }));
  const holder = async (app: string) => { const c = new Client({ host: source.sock, port: source.port, user: "nsb_owner", database: srcDb, application_name: app });
    c.on("error", () => undefined); await c.connect(); await c.query("BEGIN"); await c.query(`LOCK TABLE public.${EVAL} IN SHARE UPDATE EXCLUSIVE MODE`); return c; };
  let hold = await holder("nsb-vacuum-toast");
  const ownedBackend = await settle(source, srcDb);
  await hold.query("ROLLBACK"); await hold.end();
  hold = await holder("fixture-foreign-session");
  const foreignMaintenanceLock = await settle(source, srcDb);
  await hold.query("ROLLBACK"); await hold.end();
  const sleeper = new Client({ host: source.sock, port: source.port, user: "nsb_owner", database: srcDb, application_name: "fixture-foreign-session" });
  sleeper.on("error", () => undefined); await sleeper.connect();
  const sleeping = sleeper.query("SELECT pg_sleep(30) /* VACUUM probe */").then(() => "FINISHED", e => safeError(e).sqlState);
  await new Promise(r => setTimeout(r, 500));
  const activeMaintenanceQuery = await settle(source, srcDb);
  const canceller = await connect(source, srcDb);
  await canceller.query("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='fixture-foreign-session' AND pid<>pg_backend_pid()");
  await canceller.end(); const sleeperOutcome = await sleeping; await sleeper.end();
  psql(source, srcDb, "CREATE ROLE nsb_settle_novis LOGIN; GRANT pg_read_all_data TO nsb_settle_novis");
  const noBackendVisibility = await settle(source, srcDb, "nsb_settle_novis");
  const wrongDatabase = await settle(restore, tplDb);
  const crossPreDispatchOnMaintenance = await refusal(() => cli.disposePreDispatch({ host: hostT, purpose: lX }));
  const crossMaintenanceOnPreDispatch = await refusal(() => cli.disposeMaintenanceUnknown({ host: hostT, purpose: lY, "pg-host": source.sock,
    "pg-port": String(source.port), "pg-database": srcDb, "pg-user": "nsb_owner" }));
  const settled = await cli.disposeMaintenanceUnknown({ host: hostT, purpose: lX, "pg-host": source.sock, "pg-port": String(source.port), "pg-database": srcDb,
    "pg-user": "nsb_owner" }).catch((e: unknown) => ({ refused: safeError(e).code }));
  const proof = settled.release ? JSON.parse(await readFile(join(xDir, `maintenance-settlement-${settled.release.detail.settlementProofSha256}.json`), "utf8")) : null;
  const preDisposed = await cli.disposePreDispatch({ host: hostT, purpose: lY }).catch((e: unknown) => ({ refused: safeError(e).code }));
  cadence.legacyDispositions = {
    blockedBeforeDisposition: blocked.replace(lX, "LX").replace(lY, "LY").replace(/^(OTHER_PURPOSE_OPEN:)(LX:maintenance-ack-unknown|LY:resumable)$/, "$1LEGACY"),
    ownedBackend, foreignMaintenanceLock, activeMaintenanceQuery, sleeperCancelled: sleeperOutcome === "57014", noBackendVisibility, wrongDatabase,
    crossPreDispatchOnMaintenance, crossMaintenanceOnPreDispatch,
    settled: settled.release ? { outcome: settled.release.outcome, advancesChain: settled.release.advancesChain, successClaimed: settled.release.detail.successClaimed,
      retryPermitted: settled.release.detail.retryPermitted, unacknowledgedStage: settled.release.detail.unacknowledgedStage,
      proofDatabaseIsSource: proof.database.name === srcDb, readOnly: proof.transaction.readOnly, isolation: proof.transaction.isolation,
      rollbackAcknowledged: proof.transaction.rollbackAcknowledged, fullBackendVisibility: proof.visibility.fullBackendVisibility,
      backends: proof.backends, unitsRetiredAndRootsByteEqual: proof.units.map((u: any) => u.exactUnitAbsent && u.retainedRootsFullBytesMatch),
      historyUnchanged: await history(lX) === historyX } : settled,
    preDispatch: preDisposed.release ? { outcome: preDisposed.release.outcome, advancesChain: preDisposed.release.advancesChain,
      originalReason: preDisposed.release.detail.originalReason, successClaimed: preDisposed.release.detail.successClaimed,
      retryPermitted: preDisposed.release.detail.retryPermitted, historyUnchanged: await history(lY) === historyY } : preDisposed,
  };
  step = "cadence-expired-capture-only";
  // The 733c shape on owned state: a real canonical plan/execute in rootT acknowledges EVERY planned capture-restore, then
  // the publish fresh gate is refused at the owned DB sampler BEFORE any publish intent. The purpose keeps its lease
  // until the REAL original 30 min window from its journal begin has elapsed (no clock injection); only then the explicit
  // LOCAL-ONLY disposition ends that lease, preserving every byte, claiming nothing and never advancing the chain.
  const samplerFault = async (fault: string | undefined) => writeFile(join(DBFX, "sampler.json"),
    JSON.stringify({ ...JSON.parse(await readFile(join(DBFX, "sampler.json"), "utf8")), fault }));
  const unitTableRows = async () => { const c = await connect(source, srcDb), out: Record<string, unknown> = {};
    try { for (const tb of UNIT_TABLES) out[tb] = (await c.query(
      `SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM public.${tb} x`)).rows[0]; return out; }
    finally { await c.end(); } };
  const hostSide = async () => { const f = await fake(); return { env: sha256(await readFile(join(APP, ".env.native-archive"))), archive: await tree(ARCHIVE),
    web: [f.containers.web.Id, f.containers.web.Image, f.containers.web.State.StartedAt], worker: [f.containers.worker.Id, f.containers.worker.State.StartedAt],
    composeUpCalls: f.composeUpCalls }; };
  const preC = await productionPrestate(hostFile, purpose(), runtimeManifest, transport), hostC = join(OP, "production-host-capture-only.json");
  await writeExclusive(hostC, JSON.stringify({ ...hostConfig({ path: preC.file, sha256: preC.sha256 }), stateRoot: rootT }), 0o400);
  const cX = purpose(), frontierBeforeC = await chainFrontier(rootT), dbBeforePlanC = await unitTableRows();
  const planC = await productionPlan({ host: hostC, purpose: cX, cutoff, review, limit: "32", "max-units": "2", ...(frontierT ? { cursor: frontierT } : {}) },
    transport) as any;
  assert.equal(planC.units?.length, 2, `CAPTURE_ONLY_PLAN:${planC.units?.length}:${JSON.stringify((planC.vetoes ?? []).map((v: any) => v.code))}`);
  const batchC = join(rootT, "batches", cX), copiesC = join(rootT, "copies", cX);
  const idsC: string[] = JSON.parse(await readFile(join(batchC, "plan.json"), "utf8")).units.map((u: any) => u.generation.jobRunId);
  const dbBeforeC = await unitTableRows(), hostBeforeC = await hostSide();
  let captureAcks = 0;
  const captureOnlyTransport: ActorTransport = { kind: "fixture", async send(h, payload, timeoutMs, signal) {
    const r = await transport.send(h, payload, timeoutMs, signal);
    // After the LAST planned capture-restore ACK the owned sampler fails: the publish fresh gate refuses before its intent.
    if (h === "app" && payload.purpose === cX && payload.stage === "capture-restore" && payload.op === "db" && r.actualExitCode === 0 &&
      ++captureAcks === idsC.length) await samplerFault("fail");
    return r;
  } };
  const execC = await productionExecute({ host: hostC, purpose: cX, review }, captureOnlyTransport).finally(() => samplerFault(undefined));
  const jC = await readJournal(join(batchC, "journal")), startedC = Date.parse(jC.startedAt!), deadlineC = startedC + 30 * 60_000;
  const bytesC = async () => ({ batch: await tree(batchC), copies: await tree(copiesC), marker: sha256(await readFile(join(rootT, "purposes", `${cX}.json`))) });
  const originalC = await bytesC();
  // The app actor lists only the REQUESTING purpose's sequence: read it through cX's own plan and host.
  const appC = ((await new ProductionHostBatchBackend(JSON.parse(await readFile(hostC, "utf8")) as ProductionHostConfig,
    JSON.parse(await readFile(join(batchC, "plan.json"), "utf8")), review, transport).status()).sequence as any[]).map((e: any) => `${e.stage}:${e.op}`);
  const keptCaptureC = (await readdir(join(batchC, "remote"))).filter(n => /^app-\d{4}-capture-restore-db\.json$/.test(n)).length;
  const beforeExpiry = {
    secondPlan: (await refusal(() => planT(purpose(), frontierT ? { cursor: frontierT } : {}))).replace(cX, "CX"),
    abandon: await refusal(() => cli.abandonPurpose({ host: hostC, purpose: cX })),
    preDispatch: await refusal(() => cli.disposePreDispatch({ host: hostC, purpose: cX })),
    unexpired: await refusal(() => cli.disposeExpiredCaptureOnlyPurpose({ host: hostC, purpose: cX })),
    wellBeforeDeadline: Date.now() < deadlineC - 60_000 };
  await new Promise(r => setTimeout(r, Math.max(0, deadlineC - Date.now()) + 2_000));
  const unchangedAtExpiry = same(await bytesC(), originalC);
  const raced = await Promise.allSettled([cli.disposeExpiredCaptureOnlyPurpose({ host: hostC, purpose: cX }),
    cli.disposeExpiredCaptureOnlyPurpose({ host: hostC, purpose: cX })]);
  const wonC = raced.filter(o => o.status === "fulfilled") as PromiseFulfilledResult<any>[];
  const lostC = raced.filter(o => o.status === "rejected").map(o => safeError((o as PromiseRejectedResult).reason).code);
  const relC = await releaseRecord(rootT, cX), statusC = await ownershipStatus(rootT);
  checks.expiredCaptureOnlyObservations = { concurrentLoserCodes: lostC, originalReason: execC.reason, dbUnchangedSincePlan: same(await unitTableRows(), dbBeforePlanC),
    journalStartedAt: jC.startedAt, deadline: new Date(deadlineC).toISOString(), releasedAt: relC?.at ?? null, appRemote: appC };
  cadence.expiredCaptureOnly = {
    planUnits: idsC.length,
    original: { exit: execC.actualExitCode, stage: execC.stage, statusReadOnlyRequired: execC.statusReadOnlyRequired, retired: execC.retiredOriginalJobs.length,
      refusedAtSampler: /^PRODUCTION_ACTOR_REFUSED:/.test(execC.reason), acknowledged: jC.receipts.map(r => `${r.stage}:${r.actionAcknowledged}`),
      unacknowledged: jC.unacknowledgedIntents.length, resumes: jC.resumes },
    remote: { captureRestore: appC.filter(s => s === "capture-restore:db").length, keptCaptureReceipts: keptCaptureC,
      beyondCapture: appC.filter(s => !["plan:db", "evidence:db", "capture-restore:db"].includes(s)) },
    copiesAndRestores: await Promise.all(idsC.map(async id => { const r = JSON.parse(await readFile(join(batchC, "units", id, "restore.json"), "utf8"));
      return { copies: (await readdir(join(copiesC, id))).sort(), parity: r.frozenProofParity, plaintextDropped: r.plaintextRestoreDropped }; })),
    restoreDatabasesLeft: psql(restore, "postgres", `SELECT count(*) FROM pg_database WHERE datname LIKE 'nsb_restore_${cX}_%'`),
    beforeExpiry, unchangedAtExpiry,
    concurrent: { fulfilled: wonC.length, refused: lostC.length },
    release: relC && { outcome: relC.outcome, advancesChain: relC.advancesChain, examinedThrough: relC.examinedThrough,
      examinedBound: relC.examinedSha256 === sha256(await readFile(join(batchC, "examined.json"))), successClaimed: relC.detail.successClaimed,
      retryPermitted: relC.detail.retryPermitted, reclaimClaimed: relC.detail.reclaimClaimed, units: relC.detail.units, journalRecords: relC.detail.journalRecords,
      originalStage: relC.detail.originalStage, originalStart: relC.detail.originalStartedAt === jC.startedAt,
      deadlineIsOriginalPlus30m: relC.detail.deadlineExpiredAt === new Date(deadlineC).toISOString(), releasedAfterDeadline: Date.parse(relC.at) >= deadlineC,
      winnerReturnedRecord: same(wonC[0]?.value.release, relC) },
    bytesUnchanged: same(await bytesC(), originalC), dbUnchanged: same(await unitTableRows(), dbBeforeC), hostUnchanged: same(await hostSide(), hostBeforeC),
    owner: statusC.owner, frontierUnchanged: same(statusC.frontier, frontierBeforeC), purposeState: statusC.purposes[cX],
    afterRelease: { again: await refusal(() => cli.disposeExpiredCaptureOnlyPurpose({ host: hostC, purpose: cX })),
      resume: await refusal(() => productionExecute({ host: hostC, purpose: cX, review }, transport, true)),
      execute: await refusal(() => productionExecute({ host: hostC, purpose: cX, review }, transport)) },
  };
  (cadence.expiredCaptureOnly as Record<string, unknown>).bytesUnchangedAfterRefusals = same(await bytesC(), originalC);
  const workerDriftRun = await driftRun("recreate-worker", rootT, frontierT);
  // A NEW purpose acquires on the same root from the SAME frontier and re-plans the disposed purpose's first unit (no skip).
  const driftOwner = (await ownershipStatus(rootT)).owner!, driftEx = await examinedRecord(rootT, driftOwner);
  (cadence.expiredCaptureOnly as Record<string, unknown>).newPurposeFromSameFrontier = { planned: workerDriftRun.planUnits === 1,
    startCursorIsFrontier: same(driftEx?.startCursor ?? null, frontierBeforeC),
    sameFirstUnitReplanned: JSON.parse(await readFile(join(rootT, "batches", driftOwner, "plan.json"), "utf8")).units[0].generation.jobRunId === idsC[0] };
  checks.postApplyDrift = { imageDrift, workerDrift: workerDriftRun };
  const noRecovery = (reason: string) => ({ planUnits: 1, exit: 1, reason: `PRODUCTION_ACTOR_REFUSED:${reason}`, stage: "activate", statusReadOnlyRequired: true,
    composeUpCalls: 1, recoveryApply: null, recoveryRefused: "IDENTITY_DRIFT_NO_RECOVERY_STATUS_ONLY" });
  assert.deepEqual(checks.postApplyDrift, { imageDrift: noRecovery("SAME_EXACT_WEB_IMAGE_ENV_MOUNTS"), workerDrift: noRecovery("WORKER_NEVER_RECREATED") });

  step = "prepare-production";
  const prep = await prepareProduction({ host: hostFile, purpose: p1, stage: "retire", op: "db", "stage-op": "retire", unit: u0.generation.jobRunId });
  checks.prepareProduction = prep;

  step = "cadence-final";
  assert.deepEqual(cadence, {
    prefixRecord: { throughIsLastSettledUnit: true, planReportsThrough: true, breakCandidateIsUnsettledE3: true, orderedDatedPrefix: true,
      outcomes: ["ALREADY_ARCHIVED_ROUTE:permanent", "RETAINED_SNAPSHOT_VETO:permanent", "unit", "unit", "ARCHIVE_ENGINE_UNSUPPORTED:permanent",
        "ARCHIVE_ENGINE_METADATA_UNKNOWN:transient", "ARCHIVE_ENGINE_METADATA_UNKNOWN:transient", "SOURCE_CAPTURE_REFUSED:transient"].sort() },
    engineEligibility: {
      p1: { unsupported: "ARCHIVE_ENGINE_UNSUPPORTED:permanent", unknown: "ARCHIVE_ENGINE_METADATA_UNKNOWN:transient",
        supportedMissingEvidence: "SOURCE_CAPTURE_REFUSED:transient", unknownLongEngine: "ARCHIVE_ENGINE_METADATA_UNKNOWN:transient" },
      headersFirstInChronologicalPrefix: true,
      freezeDispatched: { unsupported: false, unknown: false, supportedMissingEvidence: true, unknownLongEngine: false },
      directCaptureOfUnsupported: { refusal: "ARCHIVE_ENGINE_UNSUPPORTED", sqlStatements: 0, evaluationSqlIssued: false },
      allVetoWindowIsFirstTwoHeadersWithTypedCodes: true, frontierAdvancedExactlyToSecondHeader: true, tVetoFreezeOnlySupported: true },
    secondPlanWhileOwnerPlanned: "OWNER_LEASE_HELD:P1", secondPlanWhileOwnerPaused: "OWNER_LEASE_HELD:P1",
    p1ReleaseOutcome: "finished", nullCursorAfterTerminalProgress: "CURSOR_BEHIND_CHAIN_FRONTIER_WOULD_RESCAN",
    aheadCursorSkippingUnexamined: "CURSOR_AHEAD_OF_FRONTIER_WOULD_SKIP_UNEXAMINED", secondPlanWhileOwnerAmbiguous: "OWNER_LEASE_HELD:P2",
    terminalScanAndAbandon: {
      emptyWindow: { units: 0, terminalScan: true, release: "terminal-scan", advancesChain: false },
      allVetoWindow: { units: 0, terminalScan: true, release: "terminal-scan", advancesChain: true, examinedSettled: 2 },
      nullCursorAfterTerminalScan: "CURSOR_BEHIND_CHAIN_FRONTIER_WOULD_RESCAN", unitPlanned: 1, abandon: "NO_REFUSAL",
      abandonRelease: "abandoned", abandonAdvancesChain: false, executeAfterAbandon: "PURPOSE_ALREADY_CONSUMED" },
    legacyDispositions: { blockedBeforeDisposition: "OTHER_PURPOSE_OPEN:LEGACY", ownedBackend: "OWNED_OPERATOR_BACKEND_PRESENT",
      foreignMaintenanceLock: "TARGET_MAINTENANCE_LOCK_PRESENT", activeMaintenanceQuery: "MAINTENANCE_BACKEND_ACTIVE", sleeperCancelled: true,
      noBackendVisibility: "BACKEND_VISIBILITY_UNAVAILABLE", wrongDatabase: "RETAINED_ROOTS_NOT_BYTE_EQUAL",
      crossPreDispatchOnMaintenance: "NOT_A_PRE_DISPATCH_REFUSAL_STATE", crossMaintenanceOnPreDispatch: "ONLY_UNACKNOWLEDGED_POST_RETIREMENT_MAINTENANCE_IS_DISPOSABLE",
      settled: { outcome: "terminal-maintenance-outcome-unknown", advancesChain: false, successClaimed: false, retryPermitted: false, unacknowledgedStage: "vacuum-toast",
        proofDatabaseIsSource: true, readOnly: "on", isolation: "repeatable read", rollbackAcknowledged: true, fullBackendVisibility: true,
        backends: { ownedOperatorBackends: 0, maintenanceQueryBackends: 0, maintenanceProgressRows: 0, maintenanceModeTargetLocks: 0 },
        unitsRetiredAndRootsByteEqual: [true, true], historyUnchanged: true },
      preDispatch: { outcome: "terminal-pre-dispatch-refused", advancesChain: false, originalReason: "MAINTENANCE_REFUSED:app_physical_reserve", successClaimed: false,
        retryPermitted: false, historyUnchanged: true } },
    expiredCaptureOnly: { planUnits: 2,
      original: { exit: 1, stage: "publish", statusReadOnlyRequired: false, retired: 0, refusedAtSampler: true,
        acknowledged: ["capture-restore:true", "capture-restore:true"], unacknowledged: 0, resumes: 0 },
      remote: { captureRestore: 2, keptCaptureReceipts: 2, beyondCapture: [] },
      copiesAndRestores: [0, 1].map(() => ({ copies: ["primary", "recovery"], parity: true, plaintextDropped: true })), restoreDatabasesLeft: "0",
      beforeExpiry: { secondPlan: "OWNER_LEASE_HELD:CX", abandon: "PURPOSE_EXECUTION_STARTED_NOT_ABANDONABLE",
        preDispatch: "PRE_DISPATCH_REQUIRES_EXACTLY_BEGIN_AND_FINISH", unexpired: "PURPOSE_DEADLINE_NOT_EXPIRED", wellBeforeDeadline: true },
      unchangedAtExpiry: true, concurrent: { fulfilled: 1, refused: 1 },
      release: { outcome: "terminal-expired-capture-only", advancesChain: false, examinedThrough: null, examinedBound: true, successClaimed: false,
        retryPermitted: false, reclaimClaimed: false, units: 2, journalRecords: 6, originalStage: "publish", originalStart: true, deadlineIsOriginalPlus30m: true,
        releasedAfterDeadline: true, winnerReturnedRecord: true },
      bytesUnchanged: true, dbUnchanged: true, hostUnchanged: true, owner: null, frontierUnchanged: true, purposeState: "released:terminal-expired-capture-only",
      afterRelease: { again: "PURPOSE_ALREADY_RELEASED", resume: "OWNER_LEASE_REQUIRED", execute: "PURPOSE_ALREADY_CONSUMED" },
      bytesUnchangedAfterRefusals: true,
      newPurposeFromSameFrontier: { planned: true, startCursorIsFrontier: true, sameFirstUnitReplanned: true } } });
  return { source, restore };
}

/** Wraps the fixture transport and rewrites ONLY the read-only status listing
 * the verifier receives (the remote files themselves stay untouched). */
class TamperedListingTransport implements ActorTransport {
  readonly kind = "fixture" as const;
  constructor(private readonly inner: ActorTransport, private readonly mutate: (sequence: any[], host: ActorHost) => any[]) {}
  async send(host: ActorHost, payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
    const r = await this.inner.send(host, payload, timeoutMs, signal);
    if ((payload.op === "status" || payload.op === "db-status") && Array.isArray(r.sequence)) r.sequence = this.mutate(structuredClone(r.sequence), host);
    return r;
  }
}

/** P1 is paused at retire with 4 ACKs (2× capture-restore, publish, activate).
 * Actor-side: identity refusals BEFORE any intent (nothing is written remotely).
 * Verifier-side: tampered read-only listings and forged local evidence in a
 * scratch state root; P1's own files are never modified. Positive: the genuine
 * paused state verifies (and the following P1 resume continues to exit 0). */
async function resumeBindingGuards(host: ProductionHostConfig, plan: NativeStorageBatchPlan, review: string, transport: ActorTransport,
  acks: NativeStorageStageReceipt[]) {
  const out: Record<string, unknown> = {}, signal = new AbortController().signal;
  const backend = () => new ProductionHostBatchBackend(host, plan, review, transport);
  const verify = (b: ProductionHostBatchBackend, receipts = acks) => refusal(() => b.verifyAcknowledged(plan, receipts, signal).then(v => { if (v !== true) throw new Error("NOT_TRUE"); }));
  const b = backend(), app = (await b.status()).sequence as any[], dbList = (await b.send("db", "db-status", "status", {}, 30_000)).sequence as any[];
  const u0 = plan.units[0]!, u1 = plan.units[1]!;
  const evidenceReq = { request: { op: "evidence", databaseBudgetBytes: host.databaseBudgetBytes, expectedRole: host.role, knownApplicationNames: [], jobRunIds: [u0.generation.jobRunId] } };
  const actor = async (mutate: (p: Record<string, any>) => void, h: ActorHost = "app", op = "db", stage = "evidence", extra: Record<string, unknown> = evidenceReq) => {
    const p = await b.payload(h, op, stage as never, extra); p.sequence = (h === "app" ? app : dbList).length + 1; mutate(p);
    const r = await transport.send(h, p, 60_000); return r.actualExitCode === 0 ? "ACCEPTED" : r.reason;
  };
  const selectionSha = sha256(await readFile(join(host.stateRoot, "batches", plan.purpose, "selection.json")));
  const config0 = JSON.parse(await readFile(join(host.stateRoot, "batches", plan.purpose, "units", `${u0.generation.jobRunId}.config.json`), "utf8"));
  out.actor = {
    foreignPlan: await actor(p => { p.planSha256 = "e".repeat(64); }),
    foreignSource: await actor(p => { p.sourceManifestSha256 = "d".repeat(64); }),
    foreignRuntimeOnDbHost: await actor(p => { p.runtimeRevision = "1".repeat(40); }, "db", "sample-capacity", "evidence", { unitJobRunIds: [] }),
    preludeAfterExecution: await actor(p => { delete p.planSha256; p.phase = "selection-prelude"; p.selectionSha256 = selectionSha; p.stage = "plan";
      p.request = { op: "select", selection: { cursor: null, limit: 32, cutoffObservedAt: plan.cutoffObservedAt } }; p.unitJobRunIds = []; }),
    preludeStageUnderExecution: await actor(p => { p.stage = "plan"; p.request = { op: "select", selection: { cursor: null, limit: 32, cutoffObservedAt: plan.cutoffObservedAt } }; p.unitJobRunIds = []; }),
    selectionDigestUnderExecution: await actor(p => { p.selectionSha256 = selectionSha; }),
    unknownTransition: await actor(p => { p.stage = "activate"; }),
    wrongUnitIdentity: await actor(p => { p.unitJobRunIds = [u1.generation.jobRunId]; }),
    duplicateAcknowledgedCapture: await actor(() => undefined, "app", "db", "capture-restore", { request: { op: "capture", capture: { generation: u0.generation,
      expectedEvaluations: u0.evaluations, expectedContexts: u0.contexts, sourceRevision: host.runtimeRevision, consumerInventorySha256: config0.consumerInventorySha256 },
    frozenProofSha256: u0.originalProofSha256 }, heldKeySha256: host.heldKey.sha256, heldKeyId: host.heldKey.keyId }),
  };
  const after = { app: (await b.status()).sequence.length, db: (await b.send("db", "db-status", "status", {}, 30_000)).sequence.length };
  out.actorWroteNothing = after.app === app.length && after.db === dbList.length;

  out.positivePausedVerification = await verify(backend());
  out.swappedAckOrder = await verify(backend(), [acks[1]!, acks[0]!, ...acks.slice(2)]);
  out.ackPointsAtOtherEvidence = await verify(backend(), [{ ...acks[0]!, evidenceSha256: acks[1]!.evidenceSha256 }, ...acks.slice(1)]);

  const entry = (seq: any[], stage: string, op: string, unit?: string) => seq.find(e => e.stage === stage && e.op === op && (!unit || e.identity.unitJobRunIds[0] === unit));
  const tampered = async (fn: (seq: any[], h: ActorHost) => void) =>
    verify(new ProductionHostBatchBackend(host, plan, review, new TamperedListingTransport(transport, (seq, h) => { fn(seq, h); return seq; })));
  out.remote = {
    foreignPlanOnCapture: await tampered((s, h) => { if (h === "app") entry(s, "capture-restore", "db", u0.generation.jobRunId).identity.planSha256 = "f".repeat(64); }),
    swappedCaptureUnits: await tampered((s, h) => { if (h !== "app") return; const a = entry(s, "capture-restore", "db", u0.generation.jobRunId), c = entry(s, "capture-restore", "db", u1.generation.jobRunId);
      [a.identity.unitJobRunIds, c.identity.unitJobRunIds] = [c.identity.unitJobRunIds, a.identity.unitJobRunIds]; }),
    relabelledSequence: await tampered((s, h) => { if (h === "app") entry(s, "capture-restore", "db", u0.generation.jobRunId).identity.sequence += 100; }),
    foreignRequestDigest: await tampered((s, h) => { if (h === "app") entry(s, "capture-restore", "db", u0.generation.jobRunId).identity.requestSha256 = "c".repeat(64); }),
    foreignResultDigest: await tampered((s, h) => { if (h === "app") entry(s, "publish", "publish-root").receipt.resultSha256 = "b".repeat(64); }),
    missingRequiredPublishRoot: await tampered((s, h) => { if (h === "app") s.splice(s.indexOf(entry(s, "publish", "publish-root")), 1); }),
    extraActivateTransition: await tampered((s, h) => { if (h !== "app") return; const x = structuredClone(entry(s, "activate", "activate-root"));
      x.sequence = s.length + 1; x.identity.sequence = x.sequence; s.push(x); }),
    foreignPurposeEvidence: await tampered((s, h) => { if (h === "db") s[0].identity.purpose = "0".repeat(12); }),
    foreignRuntimeEvidence: await tampered((s, h) => { if (h === "db") s[0].identity.runtimeRevision = "1".repeat(40); }),
    foreignSelectionPrelude: await tampered((s, h) => { if (h === "app") s[0].identity.selectionSha256 = "a".repeat(64); }),
  };

  // Forged local stage evidence in a SCRATCH state root (P1's own files are untouched).
  const stages = join(host.stateRoot, "batches", plan.purpose, "stages"), names = (await readdir(stages)).sort();
  const genuine = await Promise.all(names.map(n => readFile(join(stages, n), "utf8").then(JSON.parse)));
  let scratchIndex = 0;
  const forged = async (edit: (ev: any[]) => void) => {
    const root = join(STATE, `forged-${++scratchIndex}`), dir = join(root, "batches", plan.purpose, "stages"); await mkdirs(dir);
    await cp(join(host.stateRoot, "batches", plan.purpose, "selection.json"), join(root, "batches", plan.purpose, "selection.json"));
    const ev = structuredClone(genuine); edit(ev);
    const receipts = acks.map(a => ({ ...a }));
    for (const [i, n] of names.entries()) receipts[i]!.evidenceSha256 = await writeExclusive(join(dir, n), JSON.stringify(ev[i]));
    const scratchHost = { ...host, stateRoot: root, privateRestore: { ...host.privateRestore, socketDirectory: join(root, "sock") } };
    return verify(new ProductionHostBatchBackend(scratchHost, plan, review, transport), receipts);
  };
  out.local = {
    foreignPlanEvidence: await forged(ev => { ev[0].planSha256 = "f".repeat(64); }),
    foreignPurposeEvidence: await forged(ev => { ev[0].purpose = "0".repeat(12); }),
    foreignSourceEvidence: await forged(ev => { ev[0].sourceManifestSha256 = "d".repeat(64); }),
    otherStageEvidence: await forged(ev => { ev[0].stage = "vacuum-toast"; }),
    otherUnitsEvidence: await forged(ev => { ev[0].jobRunIds = []; }),
    otherUnitsCaptureClaimsSecondUnitRecord: await forged(ev => { ev[0].remote = [{ ...ev[1].remote[0], unitJobRunIds: ev[0].jobRunIds }]; }),
    sharedRemoteRecord: await forged(ev => { ev[1].remote = [{ ...ev[0].remote[0], unitJobRunIds: ev[1].jobRunIds }]; }),
    missingPublishCipherRecords: await forged(ev => { ev[2].remote = ev[2].remote.slice(-1); }),
  };
  // Hard guard: any deviation (including an unexpected acceptance) fails the harness.
  assert.deepEqual(out, { actor: { foreignPlan: "FOREIGN_PLAN_FOR_PURPOSE", foreignSource: "FOREIGN_SOURCE_OR_REVISION_FOR_PURPOSE",
    foreignRuntimeOnDbHost: "FOREIGN_SOURCE_OR_REVISION_FOR_PURPOSE", preludeAfterExecution: "PRELUDE_AFTER_EXECUTION",
    preludeStageUnderExecution: "PRELUDE_SELECT_FREEZE_ONLY", selectionDigestUnderExecution: "EXECUTION_BINDS_FINAL_PLAN_ONLY",
    unknownTransition: "TYPED_STAGE_TRANSITION", wrongUnitIdentity: "EXACT_UNIT_IDENTITY", duplicateAcknowledgedCapture: "STAGE_ALREADY_ACKNOWLEDGED_REMOTE" },
  actorWroteNothing: true, positivePausedVerification: "NO_REFUSAL", swappedAckOrder: "ACK_PREFIX_NOT_EXACT_SCHEDULE",
  ackPointsAtOtherEvidence: "ACK_LOCAL_EVIDENCE_DIGEST",
  remote: { foreignPlanOnCapture: "ACK_REMOTE_IDENTITY", swappedCaptureUnits: "ACK_REMOTE_IDENTITY", relabelledSequence: "ACK_REMOTE_IDENTITY",
    foreignRequestDigest: "ACK_REMOTE_IDENTITY", foreignResultDigest: "ACK_REMOTE_IDENTITY", missingRequiredPublishRoot: "ACK_REMOTE_RECEIPT_SET",
    extraActivateTransition: "UNKNOWN_EXTRA_REMOTE_STAGE_TRANSITION", foreignPurposeEvidence: "FOREIGN_REMOTE_ENTRY",
    foreignRuntimeEvidence: "FOREIGN_REMOTE_ENTRY", foreignSelectionPrelude: "FOREIGN_OR_LATE_SELECTION_PRELUDE" },
  local: { foreignPlanEvidence: "ACK_LOCAL_EVIDENCE_IDENTITY", foreignPurposeEvidence: "ACK_LOCAL_EVIDENCE_IDENTITY",
    foreignSourceEvidence: "ACK_LOCAL_EVIDENCE_IDENTITY", otherStageEvidence: "ACK_LOCAL_EVIDENCE_IDENTITY", otherUnitsEvidence: "ACK_LOCAL_EVIDENCE_IDENTITY",
    otherUnitsCaptureClaimsSecondUnitRecord: "ACK_REMOTE_IDENTITY", sharedRemoteRecord: "ACK_REMOTE_RECEIPT_SET",
    missingPublishCipherRecords: "ACK_LOCAL_EVIDENCE_IDENTITY" } });
  return out;
}

/** Real HTTP to an owned route fixture serving the FAKE host's active routing root. */
async function ownedHttpProof(plan: any, u: any, root: { sha256: string; name: string }, key: Buffer, legacySha: string, review: string) {
  const capture = JSON.parse(await readFile(join(OP, "batches", plan.purpose, "units", u.generation.jobRunId, "capture.json"), "utf8"));
  const dir = join(OP, "batches", plan.purpose, "http-proof", u.generation.jobRunId); await mkdirs(dir);
  const keyFile = join(OP, "keys/primary.key");
  const worker = join(OP, "web/.native-historical-worker");
  const { buildNativeHistoricalWorker } = await import(join(REPO_ROOT, "scripts/build-native-historical-worker.mjs"));
  await buildNativeHistoricalWorker(REPO_ROOT, join(REPO_ROOT, "lib/creative-decision-engine/native-historical-archive-worker.ts"), worker).catch(() => undefined);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: OP, TSX_TSCONFIG_PATH: join(REPO_ROOT, "tsconfig.json"),
    NSB_HOST_MODE: "owned", NSB_STATE_ROOT: OP, APP_BUILD_ID: plan.targetRevision, ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED: "true",
    ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH: join(ARCHIVE, "catalogs", `${legacySha}.json`), ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256: legacySha,
    ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID: `fx-held-${hex}`, ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT: "filesystem", ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT: ARCHIVE,
    ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED: "true", ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT: join(ARCHIVE, root.name), ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256: root.sha256 };
  void key;
  const records: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, STAGE_ENTRY_FILE], { cwd: join(OP, "web"), env, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", async (c: Buffer) => {
      out += c.toString("utf8"); const i = out.indexOf("\n"); if (i === -1) return;
      const line = JSON.parse(out.slice(0, i)); out = out.slice(i + 1);
      if (line.type !== "listening") return line.type === "result" ? resolve() : reject(new Error(line.code));
      for (const s of capture.samples) {
        const path = evidencePath(u.generation, s), r = await httpGet(line.port, path);
        await writeExclusive(join(dir, `${s.evaluationId}.body`), r.body);
        records.push({ evaluationId: s.evaluationId, path, httpStatus: r.status, cacheControl: r.cacheControl, bodyFile: `${s.evaluationId}.body`,
          bodyBytes: r.body.length, bodySha256: sha256(r.body), networkLoadingFinished: r.complete });
      }
      child.stdin.write(`${JSON.stringify({ action: "stop" })}\n`);
    });
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`WEB_SERVE_EXIT_${code}`)));
    child.stdin.write(`${JSON.stringify({ op: "web-serve", targetRevision: plan.targetRevision, keyFile })}\n`);
  });
  await writeExclusive(join(dir, "proof.json"), JSON.stringify({ contract: HTTP_PROOF_CONTRACT, transport: "owned-http-fixture", purpose: plan.purpose,
    jobRunId: u.generation.jobRunId, rootSha256: root.sha256, sourceManifestSha256: plan.sourceManifestSha256,
    actualSourceReviewSha256: sha256(await readFile(review)), observedAt: new Date().toISOString(), liveRoute: false, requests: records }));
}

async function stop(c: { data: string } | undefined) {
  if (!c) return null;
  spawnSync(`${PG}/pg_ctl`, ["-D", c.data, "-m", "immediate", "-w", "stop"], { stdio: "ignore", env: PG_ENV });
  return spawnSync(`${PG}/pg_ctl`, ["-D", c.data, "status"], { stdio: "ignore", env: PG_ENV }).status;
}
(async () => {
  let clusters: { source: { data: string }; restore: { data: string } } | undefined, failure: unknown = null;
  try { clusters = await main(); } catch (e) { failure = e; }
  const stopped = [await stop(clusters?.source ?? { data: join(FX, "pg", "source") }), await stop(clusters?.restore ?? { data: join(OP, "pg", "restore") })];
  const confirmed = stopped.every(s => s === 3 || s === 4);
  if (confirmed && STATE.startsWith(`${PRIVATE_BASE}/nsb-prodfx-`) && /^[a-f0-9]{12}$/.test(hex)) await rm(STATE, { recursive: true, force: true });
  const receipt = { contract: "native-storage-production-fixture.v1", stateRoot: "$STATE", stateRootRemoved: confirmed, clusterStopStatus: stopped,
    actualExitCode: failure ? 1 : 0, failedStep: failure ? step : null, failure: failure ? { ...safeError(failure), message: String((failure as Error)?.message ?? failure).slice(0, 300) } : null,
    checks, productionAccess: false, sshInvoked: false, transport: "fixture-local-python-non-root", keyMaterialInReceipt: false };
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  await writeExclusive(join(OUT, `production-fixture-receipt-${hex}.json`), JSON.stringify(receipt, null, 2), 0o400);
  process.stdout.write(`${JSON.stringify({ actualExitCode: receipt.actualExitCode, receipt: `production-fixture-receipt-${hex}.json`, failedStep: receipt.failedStep, failure: receipt.failure })}\n`);
  setTimeout(() => process.exit(receipt.actualExitCode), 200);
})();
