import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { NATIVE_STORAGE_BATCH_CONTRACT, NATIVE_STORAGE_BATCH_LIMITS, nativeStoragePlanDigest, runFiniteNativeStorageBatch,
  validateNativeStorageBatchPlan, type NativeStorageBatchPlan, type NativeStorageBatchUnit } from "../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import { canonicalSha, need, privateDirectory, readExact, safeError, sha256, UUID, writeExclusive } from "./common";
import { computeSourcePack, REPO_ROOT, verifySourceReview } from "./source-pack";
import { FileBatchJournal, readJournal } from "./journal";
import { hostPaths, OwnedHostBatchBackend, readActivation, type OwnedHostConfig } from "./backend";
import { ProductionSshTransport } from "./production-transport";
import { abandonPurpose, disposeExpiredCaptureOnlyPurpose, disposeMaintenanceUnknown, disposePreDispatch, ownerStatus, prepareProduction,
  productionExecute, productionPlan, productionPrestate } from "./production-cli";
import type { UnitConfig } from "./capture";

/** Finite native storage batch CLI. Default command is `prepare`: local source
 * pack + optional plan/review validation only — no database, host, network or
 * production access. Every other command needs an explicit host config whose
 * mode is "owned"; a "production" host refuses with the named missing gates. */
const USAGE = `usage:
  cli.ts [prepare] [--target <40hex>] [--plan <plan.json> --review <review>]
  cli.ts select  --host <host.json> --cutoff <iso> --limit <n> [--cursor <yyyy-mm-dd>:<uuid>]
  cli.ts plan    --host <host.json> --purpose <12hex> --cutoff <iso> --limit <n> --review <review> [--cursor ...] [--max-units <1-8>]
  cli.ts execute --host <host.json> --purpose <12hex> --review <review> [--http-proof owned-fixture|external-file] [--owned-fault drop-commit-ack:<uuid>]
  cli.ts resume  --host <host.json> --purpose <12hex> --review <review> [--http-proof owned-fixture|external-file]
  cli.ts http-proof --host <host.json> --purpose <12hex> --unit <uuid>   (owned route fixture → external proof directory)
  cli.ts status  --host <host.json> --purpose <12hex>
  production (nothing is sent unless --arm-production-transport <the same 12hex purpose> is given):
  cli.ts production-prestate --host <production-host.json> --purpose <12hex> --runtime-source-manifest <json> --arm-production-transport <12hex>
  cli.ts plan    --host <production-host.json> --purpose <12hex> --cutoff <iso> --review <review> [--max-units n] [--cursor <recorded frontier>] [--revisit true] --arm-production-transport <12hex>
  cli.ts execute|resume --host <production-host.json> --purpose <12hex> --review <review> --arm-production-transport <12hex>
  local operator state root only (no host, no transport; D149):
  cli.ts owner-status --host <production-host.json>
  cli.ts abandon --host <production-host.json> --purpose <12hex>   (owned purpose whose execution never began)
  cli.ts dispose-maintenance-unknown --host <production-host.json> --purpose <12hex> --pg-host <socket dir|loopback> --pg-port <n> --pg-database <db> --pg-user <role>
      (live SELECT-only settlement proof over that one READ ONLY connection; records an UNKNOWN outcome, never success or retry)
  cli.ts dispose-pre-dispatch-refused --host <production-host.json> --purpose <12hex>   (journal EXACTLY begin+finish, zero actions)
  cli.ts dispose-expired-capture-only --host <production-host.json> --purpose <12hex>   (original 30 min elapsed; ONLY acknowledged capture-restore per unit, refused before publish)
  cli.ts prepare-production --host <production-host.json> --purpose <12hex> --stage <stage> --op db|stage-cipher|publish-root|activate-root [--stage-op <op>] [--unit <uuid>]`;
function args(argv: string[]) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "prepare";
  need(/^[a-z-]+$/.test(command), "USAGE");
  const rest = command === argv[0] ? argv.slice(1) : argv, out: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    need(/^--[a-z-]+$/.test(rest[i] ?? "") && rest[i + 1] !== undefined, "USAGE"); out[rest[i]!.slice(2)] = rest[i + 1]!;
  }
  return { command, options: out };
}
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const headRevision = () => execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
async function loadHost(path: string | undefined): Promise<OwnedHostConfig> {
  need(path && isAbsolute(path), "HOST_CONFIG_REQUIRED");
  const host = JSON.parse((await readExact(path, 64 * 1024)).toString("utf8"));
  need(host?.mode !== "production", "PRODUCTION_HOST_USE_PRODUCTION_COMMANDS");
  need(host?.contract === "native-storage-owned-host.v1" && host.mode === "owned" && resolve(path) === join(host.stateRoot, "host.json"), "OWNED_HOST_CONFIG");
  await privateDirectory(host.stateRoot);
  for (const dir of [host.source.socketDirectory, host.restore.socketDirectory, host.pgDataDirectory])
    need(typeof dir === "string" && dir.startsWith(`${host.stateRoot}/`), "OWNED_HOST_PATHS");
  return host;
}
const purposeOf = (value: string | undefined) => { need(value && /^[a-f0-9]{12}$/.test(value), "EXACT_PURPOSE"); return value; };
const cursorOf = (value: string | undefined) => {
  if (!value) return null;
  const [asOfDate, jobRunId] = value.split(":"); need(/^\d{4}-\d{2}-\d{2}$/.test(asOfDate ?? "") && UUID.test(jobRunId ?? ""), "EXACT_CURSOR");
  return { asOfDate: asOfDate!, jobRunId: jobRunId! };
};

async function prepare(o: Record<string, string>) {
  const target = o.target ?? headRevision();
  const pack = await computeSourcePack(target);
  const out: Record<string, unknown> = { command: "prepare", productionAccess: false, databaseAccess: false, targetRevision: target,
    sourceManifestSha256: pack.sourceManifestSha256, files: pack.manifest.entries.length, limits: NATIVE_STORAGE_BATCH_LIMITS };
  if (o.plan) {
    const plan = JSON.parse(await readFile(o.plan, "utf8")) as NativeStorageBatchPlan;
    out.planDigest = validateNativeStorageBatchPlan(plan);
    need(plan.sourceManifestSha256 === pack.sourceManifestSha256 && plan.targetRevision === target, "PLAN_SOURCE_MANIFEST_MISMATCH");
    need(o.review, "REVIEW_REQUIRED");
    out.review = await verifySourceReview(o.review, { sourceManifestSha256: plan.sourceManifestSha256,
      actualSourceReviewSha256: plan.actualSourceReviewSha256, mode: "production" }).catch(e => ({ refused: safeError(e).code }));
  }
  print(out);
}

async function select(o: Record<string, string>) {
  const host = await loadHost(o.host), target = headRevision();
  const plan = { purpose: "000000000000", targetRevision: target } as NativeStorageBatchPlan;
  const backend = new OwnedHostBatchBackend(host, { ...plan, expectedDatabaseBudgetBytes: host.databaseBudgetBytes } as NativeStorageBatchPlan, "", null);
  return backend.child({ op: "select", selection: { cursor: cursorOf(o.cursor), limit: Number(o.limit), cutoffObservedAt: o.cutoff } }, { database: "source" });
}

/** Every job already reachable from the active root (legacy job list + shard records). */
async function routedJobs(host: OwnedHostConfig) {
  const { readLocalNativeHistoricalMetadata } = await import("../../lib/creative-decision-engine/native-historical-catalog-routing-store");
  const { NATIVE_HISTORICAL_ROUTING_BOUNDS: b } = await import("../../lib/creative-decision-engine/native-historical-catalog-routing");
  const routing = hostPaths(host.stateRoot).routing, active = (await readActivation(host.stateRoot)).record.rootSha256;
  const root = JSON.parse((await readLocalNativeHistoricalMetadata(routing, { kind: "root", sha256: active, maxBytes: b.rootBytes })).toString("utf8"));
  const jobs = new Set<string>(root.legacy.jobRunIds);
  for (const s of root.shards) for (const r of JSON.parse((await readLocalNativeHistoricalMetadata(routing,
    { kind: "shard", sha256: s.sha256, bytes: s.bytes, maxBytes: b.shardBytes })).toString("utf8")).records) jobs.add(r.generation.jobRunId);
  return jobs;
}

async function plan(o: Record<string, string>) {
  if (await isProductionHost(o.host)) return productionPlan(o, armedTransport(o));
  const host = await loadHost(o.host), purpose = purposeOf(o.purpose), target = headRevision();
  const pack = await computeSourcePack(target);
  need(o.review, "REVIEW_REQUIRED");
  const reviewSha = sha256(await readFile(o.review));
  await verifySourceReview(o.review, { sourceManifestSha256: pack.sourceManifestSha256, actualSourceReviewSha256: reviewSha, mode: "owned" });
  const base: NativeStorageBatchPlan = { contract: NATIVE_STORAGE_BATCH_CONTRACT, purpose, targetRevision: target,
    sourceManifestSha256: pack.sourceManifestSha256, actualSourceReviewSha256: reviewSha,
    expectedDatabaseBudgetBytes: host.databaseBudgetBytes, cutoffObservedAt: o.cutoff, units: [] };
  const backend = new OwnedHostBatchBackend(host, base, o.review, null);
  const selection = await backend.child({ op: "select", selection: { cursor: cursorOf(o.cursor), limit: Number(o.limit), cutoffObservedAt: o.cutoff } }, { database: "source" });
  const batchDir = join(hostPaths(host.stateRoot).batches, purpose), unitsDir = join(batchDir, "units");
  await mkdir(batchDir, { mode: 0o700 }); await mkdir(unitsDir, { mode: 0o700 });
  const units: NativeStorageBatchUnit[] = [], vetoes: { jobRunId: string; code: string }[] = [];
  const maxUnits = Number(o["max-units"] ?? NATIVE_STORAGE_BATCH_LIMITS.generations);
  need(Number.isInteger(maxUnits) && maxUnits >= 1 && maxUnits <= NATIVE_STORAGE_BATCH_LIMITS.generations, "FINITE_GENERATION_COUNT");
  const routed = await routedJobs(host);
  let total = 0, examined: { asOfDate: string; jobRunId: string } | null = null;
  for (const c of selection.candidates) {
    if (units.length >= maxUnits) break;
    if (c.metadataVeto) { vetoes.push({ jobRunId: c.generation.jobRunId, code: c.metadataVeto });
      examined = { asOfDate: c.generation.asOfDate, jobRunId: c.generation.jobRunId }; continue; }
    // Already served by the active root (legacy or a prior leaf): never re-published or re-planned.
    if (routed.has(c.generation.jobRunId)) { vetoes.push({ jobRunId: c.generation.jobRunId, code: "ALREADY_ARCHIVED_ROUTE" });
      examined = { asOfDate: c.generation.asOfDate, jobRunId: c.generation.jobRunId }; continue; }
    if (total + c.evaluations > NATIVE_STORAGE_BATCH_LIMITS.evaluations) break;
    examined = { asOfDate: c.generation.asOfDate, jobRunId: c.generation.jobRunId };
    try {
      const frozen = await backend.child({ op: "freeze", capture: { generation: c.generation, expectedEvaluations: c.evaluations,
        expectedContexts: c.contexts, sourceRevision: target, consumerInventorySha256: pack.sourceManifestSha256 } }, { database: "source" });
      const config = frozen.config as UnitConfig;
      need(canonicalSha(config) === frozen.proofSha256, "FROZEN_PROOF_SELF_CHECK");
      await writeExclusive(join(unitsDir, `${c.generation.jobRunId}.config.json`), JSON.stringify(config));
      units.push({ generation: config.generation, evaluations: config.evaluations, contexts: config.contexts, originalProofSha256: frozen.proofSha256 });
      total += config.evaluations;
    } catch (e) { vetoes.push({ jobRunId: c.generation.jobRunId, code: safeError(e).code }); }
  }
  if (!units.length) return { command: "plan", purpose, actualExitCode: 1, reason: "NO_ELIGIBLE_ORIGINAL_IN_CURSOR_WINDOW", units: [],
    vetoes, nextCursor: examined ?? selection.nextCursor, evaluationRowsReadBySelection: 0 };
  const value: NativeStorageBatchPlan = { ...base, units };
  validateNativeStorageBatchPlan(value);
  await writeExclusive(join(batchDir, "plan.json"), JSON.stringify(value));
  return { command: "plan", purpose, planDigest: nativeStoragePlanDigest(value), units: units.map(u => ({ jobRunId: u.generation.jobRunId,
    asOfDate: u.generation.asOfDate, evaluations: u.evaluations, contexts: u.contexts, originalProofSha256: u.originalProofSha256 })),
    vetoes, nextCursor: examined ?? selection.nextCursor, evaluationRowsReadBySelection: 0 };
}

const httpProofMode = (o: Record<string, string>) => {
  const mode = o["http-proof"] ?? "owned-fixture"; need(mode === "owned-fixture" || mode === "external-file", "HTTP_PROOF_MODE"); return mode;
};
async function loadPlan(host: OwnedHostConfig, purpose: string) {
  const batchDir = join(hostPaths(host.stateRoot).batches, purpose);
  const value = JSON.parse((await readExact(join(batchDir, "plan.json"), 1024 * 1024)).toString("utf8")) as NativeStorageBatchPlan;
  validateNativeStorageBatchPlan(value);
  need(value.purpose === purpose && value.targetRevision === headRevision(), "EXACT_PLAN_AND_IMAGE_REVISION");
  return { batchDir, value };
}
/** Resume a paused batch through the runner's own resume path: the journal
 * (explicit resume mode) admits only a pre-dispatch refusal of the same plan,
 * the backend verifies every ACK read-only, the original deadline is kept. */
async function resumeCommand(o: Record<string, string>) {
  if (await isProductionHost(o.host)) return productionExecute(o, armedTransport(o), true);
  const host = await loadHost(o.host), purpose = purposeOf(o.purpose), { batchDir, value } = await loadPlan(host, purpose);
  need(o.review, "REVIEW_REQUIRED");
  const journal = new FileBatchJournal(join(batchDir, "journal"), hostPaths(host.stateRoot).purposes, "resume");
  const backend = new OwnedHostBatchBackend(host, value, o.review, journal, { httpProof: httpProofMode(o) });
  const result = await runFiniteNativeStorageBatch(value, journal, backend);
  await writeExclusive(join(batchDir, `result-resume-${Date.now()}.json`), JSON.stringify(result));
  return result;
}
/** OWNED ONLY: produce the external proof directory through the owned route fixture (stands in for the Chrome step). */
async function httpProofCommand(o: Record<string, string>) {
  const host = await loadHost(o.host), purpose = purposeOf(o.purpose), { value } = await loadPlan(host, purpose);
  const unit = value.units.find(u => u.generation.jobRunId === o.unit); need(unit, "PLAN_UNIT_REQUIRED");
  const backend = new OwnedHostBatchBackend(host, value, "", null);
  const root = (await readActivation(host.stateRoot)).record.rootSha256;
  const dir = await backend.captureOwnedHttpProof(unit, root, unit.generation.jobRunId);
  return { command: "http-proof", transport: "owned-http-fixture", liveRoute: false, proofDirectory: dir.replace(host.stateRoot, "$STATE"), rootSha256: root };
}

/** The ONLY production transport the CLI builds: SSH, armed for exactly one purpose. */
const armedTransport = (o: Record<string, string>) => new ProductionSshTransport(o["arm-production-transport"] ? purposeOf(o["arm-production-transport"]) : null);
const isProductionHost = async (path: string | undefined) => {
  need(path && isAbsolute(path), "HOST_CONFIG_REQUIRED");
  return JSON.parse((await readExact(path, 256 * 1024)).toString("utf8"))?.mode === "production";
};

const productionOnly = (fn: (o: Record<string, string>) => Promise<unknown>) => async (o: Record<string, string>) => {
  need(await isProductionHost(o.host), "PRODUCTION_HOST_REQUIRED"); return fn(o);
};

async function execute(o: Record<string, string>) {
  need(o.host && isAbsolute(o.host), "HOST_CONFIG_REQUIRED");
  const raw = JSON.parse((await readExact(o.host, 256 * 1024)).toString("utf8"));
  if (raw?.mode === "production") return productionExecute(o, armedTransport(o));
  const host = await loadHost(o.host), purpose = purposeOf(o.purpose);
  const batchDir = join(hostPaths(host.stateRoot).batches, purpose);
  const value = JSON.parse((await readExact(join(batchDir, "plan.json"), 1024 * 1024)).toString("utf8")) as NativeStorageBatchPlan;
  validateNativeStorageBatchPlan(value);
  need(value.purpose === purpose && value.targetRevision === headRevision(), "EXACT_PLAN_AND_IMAGE_REVISION");
  need(o.review, "REVIEW_REQUIRED");
  const consumed = await readFile(join(hostPaths(host.stateRoot).purposes, `${purpose}.json`)).then(() => true, () => false);
  need(!consumed, "PURPOSE_ALREADY_CONSUMED");
  const faults: { dropReplyAfterCommitChallenge?: string } = {};
  if (o["owned-fault"]) { const [kind, job] = o["owned-fault"].split(":"); need(kind === "drop-commit-ack" && UUID.test(job ?? ""), "OWNED_FAULT"); faults.dropReplyAfterCommitChallenge = job; }
  const journal = new FileBatchJournal(join(batchDir, "journal"), hostPaths(host.stateRoot).purposes);
  const backend = new OwnedHostBatchBackend(host, value, o.review, journal, { faults, httpProof: httpProofMode(o) });
  const result = await runFiniteNativeStorageBatch(value, journal, backend);
  await writeExclusive(join(batchDir, "result.json"), JSON.stringify(result));
  return result;
}

/** READ-ONLY recovery: journal chain + a fresh read-only readback for any
 * unacknowledged retire. Never retries, commits, vacuums or republishes. */
async function status(o: Record<string, string>) {
  const host = await loadHost(o.host), purpose = purposeOf(o.purpose);
  const batchDir = join(hostPaths(host.stateRoot).batches, purpose);
  const journal = await readJournal(join(batchDir, "journal"));
  const out: Record<string, unknown> = { command: "status", purpose, readOnly: true, retryPerformed: false, ...journal, plan: undefined,
    planDigest: journal.plan ? nativeStoragePlanDigest(journal.plan) : null };
  const pending = journal.unacknowledgedIntent;
  if (pending && journal.plan && (pending.stage === "retire" || pending.stage === "independent-readback")) {
    const unit = (journal.plan as NativeStorageBatchPlan).units.find(u => u.generation.jobRunId === pending.jobRunIds[0])!;
    const backend = new OwnedHostBatchBackend(host, journal.plan, "", null);
    const config = await backend.frozenConfig(unit);
    const back = await backend.child({ op: "readback", config, proofSha256: unit.originalProofSha256 }, { database: "source" });
    out.ambiguousUnit = { jobRunId: unit.generation.jobRunId, exactUnitAbsent: back.exactUnitAbsent, evaluationsPresent: back.evaluationsPresent,
      contextsPresent: back.contextsPresent, retainedRootsFullBytesMatch: back.retainedRootsFullBytesMatch,
      disposition: back.exactUnitAbsent ? "COMMITTED_OBSERVED_READ_ONLY" : back.evaluationsPresent === unit.evaluations ? "NOT_COMMITTED_OBSERVED_READ_ONLY" : "PARTIAL_OR_DRIFTED_STATUS_ONLY" };
  }
  return out;
}

async function main() {
  const { command, options } = args(process.argv.slice(2));
  if (command === "prepare") return prepare(options);
  const handlers: Record<string, (o: Record<string, string>) => Promise<unknown>> = { select, plan, execute, status,
    resume: resumeCommand, "http-proof": httpProofCommand, "prepare-production": prepareProduction,
    "owner-status": productionOnly(ownerStatus), abandon: productionOnly(abandonPurpose), "dispose-maintenance-unknown": productionOnly(disposeMaintenanceUnknown),
    "dispose-pre-dispatch-refused": productionOnly(disposePreDispatch), "dispose-expired-capture-only": productionOnly(disposeExpiredCaptureOnlyPurpose),
    "production-prestate": (x: Record<string, string>) => productionPrestate(x.host!, purposeOf(x.purpose), x["runtime-source-manifest"]!, armedTransport(x)) };
  need(handlers[command], "USAGE");
  const value = await handlers[command]!(options) as { actualExitCode?: number };
  print(value);
  if (value && value.actualExitCode === 1) process.exitCode = 1;
}
main().catch(error => { process.stderr.write(`${JSON.stringify(safeError(error))}\n${USAGE}\n`); process.exitCode = 1; });
