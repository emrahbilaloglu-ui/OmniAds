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
import { safeError, same, sha256, writeExclusive } from "./common";
import { computeSourcePack, PINNED_LIBRARY_FILES, REPO_ROOT, TSX_LOADER } from "./source-pack";
import { databaseUrl } from "./backend";
import { readJournal } from "./journal";
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
  for (const n of [7, 6, 5, 4, 3, 0]) prod[n] = await seedCalibration(db, t, day(n), clock(day(n), 1));
  const g = (n: number, h: number, per: number[], tag: string, snapshots = false) =>
    seedGeneration(db, t, { date: day(n), clock: clock(day(n), 1), finishedAt: clock(day(n), h), producer: prod[n]!, perAccount: per, snapshots, tag });
  const LG = await g(7, 2, [5, 0], "legacy"), E1 = await g(7, 3, [12, 9], "e1"), L7 = await g(7, 4, [6, 0], "l7", true);
  const E2 = await g(6, 2, [0, 15], "e2"), E3 = await g(5, 2, [11, 0], "e3");
  await g(4, 2, [3, 0], "later"); await g(3, 2, [4, 0], "e4"); await g(0, 2, [2, 0], "current");
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
  checks.p1Plan = { units: plan1.units?.map((u: any) => u.evaluations), vetoes: plan1.vetoes?.map((v: any) => v.code).sort() };

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
  const plan2 = await productionPlan({ host: hostFile2, purpose: p2, cutoff, review, limit: "32", "max-units": "1" }, transport) as any;
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

  step = "post-apply-drift-no-recovery";
  // The gate passed, then the apply produced a foreign web image / touched the worker: ONE apply, no recovery recreate, status-only.
  const driftRun = async (fault: string) => {
    const preX = await productionPrestate(hostFile, purpose(), runtimeManifest, transport), hostX = join(OP, `production-host-${fault}.json`);
    await writeExclusive(hostX, JSON.stringify(hostConfig({ path: preX.file, sha256: preX.sha256 })), 0o400);
    const pX = purpose(), planX = await productionPlan({ host: hostX, purpose: pX, cutoff, review, limit: "32", "max-units": "1" }, transport) as any;
    assert.equal(planX.units?.length, 1, `DRIFT_RUN_PLAN:${JSON.stringify(planX.vetoes ?? planX.reason)}`);
    const calls0 = (await fake(st => { st.faults = { composeUp: fault }; })).composeUpCalls;
    const execX = await productionExecute({ host: hostX, purpose: pX, review }, transport);
    const afterX = await fake(st => { st.faults = {}; });
    const kept = (await readdir(join(OP, "batches", pX, "remote"))).filter(n => n.endsWith("-activate-activate-root.json"));
    const receipt = JSON.parse(await readFile(join(OP, "batches", pX, "remote", kept[0]!), "utf8"));
    return { planUnits: planX.units?.length, exit: execX.actualExitCode, reason: execX.reason, stage: execX.stage, statusReadOnlyRequired: execX.statusReadOnlyRequired,
      composeUpCalls: afterX.composeUpCalls - calls0, recoveryApply: receipt.recoveryApply ?? null, recoveryRefused: receipt.recoveryRefused ?? null };
  };
  const imageDrift = await driftRun("foreign-web-image");
  // Operator puts the live web back on the runtime image with the env the archive file now names (P3's own root).
  const archiveNow = Object.fromEntries((await readFile(join(APP, ".env.native-archive"), "utf8")).trim().split("\n").map(kv));
  await fake(st => { const w = st.containers.web; w.Image = webImage; w.Config.Env = merged(images.web, { ...composeBase.web, APP_BUILD_ID: RUNTIME, ...archiveNow });
    w.Config.Labels["org.opencontainers.image.revision"] = RUNTIME; w.Id = hex64(); w.State.StartedAt = new Date().toISOString(); });
  const workerDriftRun = await driftRun("recreate-worker");
  checks.postApplyDrift = { imageDrift, workerDrift: workerDriftRun };
  const noRecovery = (reason: string) => ({ planUnits: 1, exit: 1, reason: `PRODUCTION_ACTOR_REFUSED:${reason}`, stage: "activate", statusReadOnlyRequired: true,
    composeUpCalls: 1, recoveryApply: null, recoveryRefused: "IDENTITY_DRIFT_NO_RECOVERY_STATUS_ONLY" });
  assert.deepEqual(checks.postApplyDrift, { imageDrift: noRecovery("SAME_EXACT_WEB_IMAGE_ENV_MOUNTS"), workerDrift: noRecovery("WORKER_NEVER_RECREATED") });

  step = "prepare-production";
  const prep = await prepareProduction({ host: hostFile, purpose: p1, stage: "retire", op: "db", "stage-op": "retire", unit: u0.generation.jobRunId });
  checks.prepareProduction = prep;
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
