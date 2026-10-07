import { spawn } from "node:child_process";
import { mkdir, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { nativeStoragePlanDigest, type NativeStorageBatchBackend, type NativeStorageBatchPlan, type NativeStorageBatchUnit,
  type NativeStorageStage, type NativeStorageStageReceipt } from "../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import type { NativeStorageMaintenanceEvidence, NativeStorageOperation } from "../../lib/sync/native-storage-maintenance-admission";
import type { DbGrowthFenceDecision } from "../../lib/sync/db-growth-fence";
import { buildNativeHistoricalCatalogRouting, NativeHistoricalCatalogRouter, NATIVE_HISTORICAL_ROUTING_BOUNDS,
  type NativeHistoricalMetadataKind } from "../../lib/creative-decision-engine/native-historical-catalog-routing";
import { persistLocalNativeHistoricalRouting, readLocalNativeHistoricalMetadata } from "../../lib/creative-decision-engine/native-historical-catalog-routing-store";
import { openImmutableNativeHistoricalArchiveCatalog } from "../../lib/creative-decision-engine/native-historical-archive";
import { BatchRefusal, canonicalSha, need, pad, privateDirectory, readExact, same, sha256, sortedEntries, writeExclusive } from "./common";
import { toastObservationAcknowledged, toastObservationEvidence } from "./maintenance";
import { producerExclusionKey } from "./input-evidence-lifecycle";
import type { UnitConfig } from "./capture";
import { computeSourcePack, REPO_ROOT, TSX_LOADER, verifySourceReview } from "./source-pack";
import type { FileBatchJournal } from "./journal";
import { evidencePath, httpGet, HTTP_PROOF_CONTRACT, verifyHttpProof, type HttpProofRecord, type Sample } from "./http-proof";

/** OWNED host adapter: every stage is a real separate process against an owned
 * PostgreSQL cluster/socket, a real local object store and routing root, and a
 * fresh "web" process using the production historical reader. Nothing here can
 * address a production host: the stage child refuses any non-owned socket. */
export const STAGE_ENTRY = join(REPO_ROOT, "scripts/native-storage-batch/stage-entry.ts");
export interface OwnedHostConfig {
  contract: "native-storage-owned-host.v1"; mode: "owned"; stateRoot: string; role: string;
  source: { socketDirectory: string; port: number; database: string };
  restore: { socketDirectory: string; port: number; template: string };
  pgDataDirectory: string; databaseBudgetBytes: number; knownApplicationNames: string[]; keyId: string;
  legacySha256: string;
}
export interface OwnedFaults { dropReplyAfterCommitChallenge?: string }
/** owned-fixture: the backend itself performs real HTTP to the owned route
 * fixture. external-file: retire waits (pause) for an operator proof directory
 * (e.g. authenticated Chrome bodies) and the batch resumes later. */
export type HttpProofMode = "owned-fixture" | "external-file";
export interface OwnedBackendOptions { faults?: OwnedFaults; httpProof?: HttpProofMode }
export const hostPaths = (stateRoot: string) => ({ archive: join(stateRoot, "archive"), routing: join(stateRoot, "routing"),
  copies: join(stateRoot, "copies"), keys: join(stateRoot, "keys"), activation: join(stateRoot, "activation"),
  web: join(stateRoot, "web"), batches: join(stateRoot, "batches"), purposes: join(stateRoot, "purposes"),
  legacyCatalog: join(stateRoot, "legacy-catalog.json") });
export const databaseUrl = (role: string, socketDirectory: string, port: number, database: string) =>
  `postgresql://${encodeURIComponent(role)}@localhost/${database}?host=${encodeURIComponent(socketDirectory)}&port=${port}`;
const GiB = 1024 ** 3, MiB = 1024 ** 2;
const LIMITS: Record<string, number> = { "healthcheck-sample": 15_000, evidence: 30_000, select: 30_000, freeze: 120_000,
  capture: 120_000, pins: 30_000, restore: 120_000, retire: 75_000, readback: 60_000, vacuum: 75_000, "toast-observation": 30_000, space: 30_000,
  "fresh-read": 45_000,
  "web-serve": 60_000 };

export async function readActivation(stateRoot: string) {
  const dir = hostPaths(stateRoot).activation;
  const names = (await sortedEntries(dir)).filter(n => /^\d{4}\.json$/.test(n));
  need(names.length > 0, "BASELINE_ACTIVATION_REQUIRED");
  names.forEach((n, i) => need(n === `${pad(i + 1)}.json`, "ACTIVATION_SEQUENCE_GAP"));
  const record = JSON.parse((await readExact(join(dir, names.at(-1)!), 64 * 1024)).toString("utf8"));
  return { sequence: names.length, record };
}
export function unitLockKey(jobRunId: string): [number, number] {
  const h = sha256(`finite-native-storage-unit:${jobRunId}`);
  return [parseInt(h.slice(0, 8), 16) | 0, parseInt(h.slice(8, 16), 16) | 0];
}

export class OwnedHostBatchBackend implements NativeStorageBatchBackend {
  private readonly paths; private readonly batchDir; private stageSequence = 0;
  private rootBeforeBatch: string | null = null; private publishedRoot: string | null = null; private activated = false;
  private readonly faults: OwnedFaults; readonly httpProof: HttpProofMode;
  constructor(private readonly host: OwnedHostConfig, private readonly plan: NativeStorageBatchPlan,
    private readonly reviewPath: string, private readonly journal: FileBatchJournal | null, options: OwnedBackendOptions = {}) {
    this.faults = options.faults ?? {}; this.httpProof = options.httpProof ?? "owned-fixture";
    need(host.contract === "native-storage-owned-host.v1" && host.mode === "owned", "OWNED_HOST_CONFIG");
    need(host.databaseBudgetBytes === plan.expectedDatabaseBudgetBytes, "BUDGET_IS_HOST_CONFIG_NOT_OVERRIDE");
    this.paths = hostPaths(host.stateRoot); this.batchDir = join(this.paths.batches, plan.purpose);
  }
  private unitDir(u: NativeStorageBatchUnit) { return join(this.batchDir, "units", u.generation.jobRunId); }
  private copyDir(u: NativeStorageBatchUnit) { return join(this.paths.copies, this.plan.purpose, u.generation.jobRunId); }
  async frozenConfig(u: NativeStorageBatchUnit): Promise<UnitConfig> {
    const bytes = await readExact(join(this.batchDir, "units", `${u.generation.jobRunId}.config.json`), 4 * MiB);
    const config = JSON.parse(bytes.toString("utf8")) as UnitConfig;
    need(canonicalSha(config) === u.originalProofSha256 && same(config.generation, u.generation) &&
      config.evaluations === u.evaluations && config.contexts === u.contexts, "EXACT_FROZEN_UNIT_CONFIG");
    return config;
  }
  private async state(u: NativeStorageBatchUnit, name: string) {
    try { return JSON.parse((await readExact(join(this.unitDir(u), name), 4 * MiB)).toString("utf8")); }
    catch (e) { if ((e as { code?: string }).code === "ENOENT") return null; throw e; }
  }

  /** One stage child. Sanitized env (no inherited override/budget/provider flags). */
  child(request: Record<string, unknown>, opts: { database?: "source" | "restore-admin"; signal?: AbortSignal; extraEnv?: Record<string, string>;
    onLine?: (line: any, write: (v: unknown) => void, kill: () => void) => Promise<boolean | void> } = {}): Promise<any> {
    const op = String(request.op), limit = LIMITS[op];
    need(limit, "CLOSED_OPERATION_SET");
    // Sanitized env: nothing inherited (no override/budget/provider flags); NODE_ENV as in the runtime containers.
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.host.stateRoot,
      TSX_TSCONFIG_PATH: join(REPO_ROOT, "tsconfig.json"), NSB_HOST_MODE: "owned", NSB_STATE_ROOT: this.host.stateRoot,
      APP_BUILD_ID: this.plan.targetRevision, DB_SSL_MODE: "disable", ...opts.extraEnv };
    if (opts.database === "source") env.DATABASE_URL = env.DATABASE_URL_UNPOOLED = databaseUrl(this.host.role, this.host.source.socketDirectory, this.host.source.port, this.host.source.database);
    if (opts.database === "restore-admin") env.DATABASE_URL = databaseUrl(this.host.role, this.host.restore.socketDirectory, this.host.restore.port, "postgres");
    return new Promise((resolvePromise, reject) => {
      const proc = spawn(process.execPath, ["--import", TSX_LOADER, STAGE_ENTRY], { cwd: this.paths.web, env, stdio: ["pipe", "pipe", "pipe"] });
      let settled = false, out = "", stderrBytes = 0, stderrHash = "";
      const stderrChunks: Buffer[] = [];
      const finish = (error: Error | null, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort); if (error) reject(error); else resolvePromise(value); };
      const kill = () => { try { proc.kill("SIGKILL"); } catch { /* already exited */ } };
      const onAbort = () => { kill(); finish(new BatchRefusal("STAGE_ABORTED_STATUS_ONLY")); };
      const timer = setTimeout(() => { kill(); finish(new BatchRefusal(`STAGE_CHILD_DEADLINE:${op}`)); }, limit);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const write = (v: unknown) => proc.stdin.write(`${JSON.stringify(v)}\n`);
      proc.stderr.on("data", (c: Buffer) => { stderrBytes += c.length; if (stderrBytes <= 256 * 1024) stderrChunks.push(c); });
      proc.stdout.on("data", async (chunk: Buffer) => {
        out += chunk.toString("utf8"); need(out.length <= 16 * MiB, "BOUNDED_CHILD_OUTPUT");
        let index; while ((index = out.indexOf("\n")) !== -1) {
          const line = JSON.parse(out.slice(0, index)); out = out.slice(index + 1);
          if (line.type === "result") finish(null, line.value);
          else if (line.type === "error") finish(new BatchRefusal(line.code ?? "STAGE_REFUSED"));
          else if (opts.onLine) {
            try { if (await opts.onLine(line, write, kill)) finish(new BatchRefusal("RETIRE_COMMIT_AMBIGUOUS_STATUS_ONLY")); }
            catch (e) { kill(); finish(e as Error); }
          } else { kill(); finish(new BatchRefusal("UNEXPECTED_CHILD_PROTOCOL")); }
        }
      });
      proc.on("close", code => { stderrHash = sha256(Buffer.concat(stderrChunks));
        finish(new BatchRefusal(`STAGE_CHILD_EXIT_WITHOUT_RESULT:${op}:${code}:${stderrHash.slice(0, 12)}`)); });
      proc.on("error", () => finish(new BatchRefusal("STAGE_CHILD_SPAWN_FAILED")));
      write({ ...request, targetRevision: this.plan.targetRevision });
    });
  }

  readerEnv(rootSha256: string): Record<string, string> {
    return { ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED: "true", ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH: this.paths.legacyCatalog,
      ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256: this.host.legacySha256, ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID: this.host.keyId,
      ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT: "filesystem", ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT: this.paths.archive,
      ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED: "true", ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT: this.paths.routing,
      ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256: rootSha256 };
  }
  httpProofRoot() { return join(this.batchDir, "http-proof"); }
  private async samples(u: NativeStorageBatchUnit) {
    const capture = await this.state(u, "capture.json"); need(capture, "CAPTURE_STATE_REQUIRED");
    return capture.samples as Sample[];
  }
  /** Real HTTP GETs against a NEW owned web process (route fixture), complete
   * bodies saved EXCL, then the proof is written and verified like any other. */
  async captureOwnedHttpProof(u: NativeStorageBatchUnit, rootSha256: string, directoryName: string, signal?: AbortSignal) {
    const samples = await this.samples(u), dir = join(this.httpProofRoot(), directoryName);
    await mkdir(this.httpProofRoot(), { recursive: true, mode: 0o700 }); await mkdir(dir, { mode: 0o700 });
    const records: HttpProofRecord[] = [];
    let identity: { sourceManifestSha256: string; routingRootSha256: string } | null = null;
    await this.child({ op: "web-serve", keyFile: join(this.paths.keys, `${this.host.keyId}.key`) }, { extraEnv: this.readerEnv(rootSha256), signal,
      onLine: async (line, write) => {
        need(line.type === "listening" && Number.isInteger(line.port) && !identity, "UNEXPECTED_CHILD_PROTOCOL");
        identity = { sourceManifestSha256: line.sourceManifestSha256, routingRootSha256: line.routingRootSha256 };
        for (const sample of samples) {
          const path = evidencePath(u.generation, sample), r = await httpGet(line.port, path);
          await writeExclusive(join(dir, `${sample.evaluationId}.body`), r.body);
          records.push({ evaluationId: sample.evaluationId, path, httpStatus: r.status, cacheControl: r.cacheControl,
            bodyFile: `${sample.evaluationId}.body`, bodyBytes: r.body.length, bodySha256: sha256(r.body), networkLoadingFinished: r.complete });
        }
        write({ action: "stop" });
      } });
    const id = identity as { sourceManifestSha256: string; routingRootSha256: string } | null;
    need(id && id.sourceManifestSha256 === this.plan.sourceManifestSha256 && id.routingRootSha256 === rootSha256, "SAME_IMAGE_WEB_REQUIRED");
    await writeExclusive(join(dir, "proof.json"), JSON.stringify({ contract: HTTP_PROOF_CONTRACT, transport: "owned-http-fixture",
      purpose: this.plan.purpose, jobRunId: u.generation.jobRunId, rootSha256, sourceManifestSha256: this.plan.sourceManifestSha256,
      actualSourceReviewSha256: this.plan.actualSourceReviewSha256, observedAt: new Date().toISOString(), liveRoute: false, requests: records }));
    return dir;
  }
  /** Retire admission input. external-file mode with no proof writes a PAUSE
   * record (required request paths only) and reports false: the runner then
   * refuses BEFORE any intent, and `resume` continues later. */
  private async retireHttpProof(u: NativeStorageBatchUnit, rootSha256: string, signal?: AbortSignal) {
    const activation = await readActivation(this.host.stateRoot), config = await this.frozenConfig(u), samples = await this.samples(u);
    need(activation.record.rootSha256 === rootSha256, "ACTIVE_ROOT_CHANGED");
    let dir = join(this.httpProofRoot(), u.generation.jobRunId);
    if (this.httpProof === "owned-fixture") dir = await this.captureOwnedHttpProof(u, rootSha256, `${u.generation.jobRunId}.owned-${Date.now()}`, signal);
    else if (!(await readExact(join(dir, "proof.json"), 256 * 1024).then(() => true, () => false))) {
      await mkdir(this.httpProofRoot(), { recursive: true, mode: 0o700 });
      await writeExclusive(join(this.httpProofRoot(), `PAUSE-${u.generation.jobRunId}.json`), JSON.stringify({ contract: "native-storage-http-proof-pause.v1",
        purpose: this.plan.purpose, jobRunId: u.generation.jobRunId, rootSha256, proofDirectory: `http-proof/${u.generation.jobRunId}`,
        requiredTransport: "chrome-authenticated (owned host also accepts owned-http-fixture)",
        requests: samples.map(sample => evidencePath(u.generation, sample)) })).catch(() => undefined);
      return { matches: false, paused: true };
    }
    try {
      const verified = await verifyHttpProof(dir, { purpose: this.plan.purpose, jobRunId: u.generation.jobRunId, rootSha256,
        sourceManifestSha256: this.plan.sourceManifestSha256, actualSourceReviewSha256: this.plan.actualSourceReviewSha256,
        generation: u.generation, samples, rowSha256: config.evaluationRowSha256,
        activatedAt: activation.record.activatedAt, nowMs: Date.now(), allowOwnedFixture: true });
      return { ...verified, paused: false };
    } catch { return { matches: false, paused: false }; }
  }

  private async freshReads(units: NativeStorageBatchUnit[], rootSha256: string) {
    const requests: Record<string, unknown>[] = [], expected = new Map<string, string>();
    for (const u of units) {
      const config = await this.frozenConfig(u), capture = await this.state(u, "capture.json");
      need(capture, "CAPTURE_STATE_REQUIRED");
      for (const s of capture.samples as { evaluationId: string; providerAccountId: string; adId: string }[]) {
        requests.push({ generation: u.generation, providerAccountId: s.providerAccountId, adId: s.adId, evaluationId: s.evaluationId });
        expected.set(s.evaluationId, config.evaluationRowSha256[s.evaluationId]!);
      }
    }
    const result = await this.child({ op: "fresh-read", requests, keyFile: join(this.paths.keys, `${this.host.keyId}.key`) }, { extraEnv: this.readerEnv(rootSha256) });
    const reads = result.reads as { evaluationId: string; status: string; evaluationSha256: string | null; providerAuthority: boolean | null }[];
    const matches = reads.length === requests.length && reads.every(r => r.status === "historical_available" &&
      r.providerAuthority === false && r.evaluationSha256 === expected.get(r.evaluationId)) &&
      result.sourceManifestSha256 === this.plan.sourceManifestSha256 && result.routingRootSha256 === rootSha256;
    return { matches, reads: reads.length, workerSha256: result.workerSha256 as string, sameImageSource: result.sourceManifestSha256 === this.plan.sourceManifestSha256 };
  }
  /** Byte-level re-check of both complete encrypted copies against capture state. */
  private async copiesMatch(u: NativeStorageBatchUnit) {
    const capture = await this.state(u, "capture.json");
    if (!capture) return { ok: false, bytes: 0, population: 0 };
    let bytes = 0;
    for (const p of capture.metadata.parts as { ciphertextSha256: string; ciphertextBytes: number }[]) {
      const a = await readExact(join(this.paths.archive, "native/v2", `${p.ciphertextSha256}.bin`), 2 * MiB + 128);
      const b = await readExact(join(this.copyDir(u), `${p.ciphertextSha256}.bin`), 2 * MiB + 128);
      if (sha256(a) !== p.ciphertextSha256 || sha256(b) !== p.ciphertextSha256 || a.length !== p.ciphertextBytes) return { ok: false, bytes: 0, population: 0 };
      bytes += a.length;
    }
    const leaf = await readExact(join(this.copyDir(u), `leaf-${capture.metadata.leafSha256}.json`), NATIVE_HISTORICAL_ROUTING_BOUNDS.leafBytes);
    if (sha256(leaf) !== capture.metadata.leafSha256) return { ok: false, bytes: 0, population: 0 };
    const catalog = openImmutableNativeHistoricalArchiveCatalog(leaf, capture.metadata.leafSha256);
    const population = new Set(catalog.entries.flatMap(e => e.segment!.evaluationIds)).size;
    return { ok: true, bytes: bytes + leaf.length, population };
  }

  /** RESUME ONLY: re-derive in-memory state from ACKed stages and verify every
   * ACK read-only (evidence file digest, both copies, restore parity, published
   * root, current activation, independent absence + retained roots). Never
   * re-executes an action. */
  async verifyAcknowledged(plan: NativeStorageBatchPlan, acks: NativeStorageStageReceipt[], signal: AbortSignal): Promise<boolean> {
    need(plan.purpose === this.plan.purpose && nativeStoragePlanDigest(plan) === nativeStoragePlanDigest(this.plan), "RESUME_SAME_MANIFEST_BOUND_PLAN");
    const stagesDir = join(this.batchDir, "stages"), bySha = new Map<string, string>();
    const files = await sortedEntries(stagesDir).catch(() => [] as string[]);
    for (const f of files) bySha.set(sha256(await readExact(join(stagesDir, f), 16 * MiB)), f);
    this.stageSequence = files.length;
    const out: { stage: string; jobRunIds: string[]; verified: string }[] = [];
    for (const ack of acks) {
      need(bySha.has(ack.evidenceSha256), "ACK_EVIDENCE_FILE_MISSING");
      const units = this.plan.units.filter(u => ack.jobRunIds.includes(u.generation.jobRunId));
      need(units.length === ack.jobRunIds.length, "ACK_UNIT_SET");
      let verified = "evidence_file_digest";
      if (ack.stage === "capture-restore") {
        for (const u of units) need((await this.copiesMatch(u)).ok && (await this.state(u, "restore.json"))?.frozenProofParity === true, "ACK_CAPTURE_RESTORE_NOT_VERIFIED");
        verified = "both_copies_bytes_and_restore_parity";
      } else if (ack.stage === "publish") {
        const pub = JSON.parse((await readExact(join(this.batchDir, "publication.json"), MiB)).toString("utf8"));
        await readLocalNativeHistoricalMetadata(this.paths.routing, { kind: "root", sha256: pub.rootSha256, maxBytes: NATIVE_HISTORICAL_ROUTING_BOUNDS.rootBytes });
        this.publishedRoot = pub.rootSha256; this.rootBeforeBatch = pub.previousRootSha256; verified = "published_root_readable";
      } else if (ack.stage === "activate") {
        const current = await readActivation(this.host.stateRoot);
        need(this.publishedRoot && current.record.rootSha256 === this.publishedRoot && current.record.purpose === this.plan.purpose, "ACTIVE_ROOT_CHANGED_SINCE_ACK");
        this.activated = true; verified = "current_activation_is_this_batch_root";
      } else if (ack.stage === "retire" || ack.stage === "independent-readback") {
        for (const u of units) {
          const back = await this.child({ op: "readback", config: await this.frozenConfig(u), proofSha256: u.originalProofSha256 }, { database: "source", signal });
          need(back.exactUnitAbsent === true && back.retainedRootsFullBytesMatch === true, "ACK_RETIREMENT_NOT_OBSERVED");
        }
        verified = "independent_read_only_absence_and_roots";
      }
      out.push({ stage: ack.stage, jobRunIds: ack.jobRunIds, verified });
    }
    if (!acks.some(a => a.stage === "publish")) this.rootBeforeBatch = (await readActivation(this.host.stateRoot)).record.rootSha256;
    await writeExclusive(join(this.batchDir, `resume-verification-${Date.now()}.json`), JSON.stringify(out));
    return true;
  }

  async freshEvidence(operation: NativeStorageOperation, units: NativeStorageBatchUnit[], signal?: AbortSignal): Promise<{
    business: DbGrowthFenceDecision; evidence: NativeStorageMaintenanceEvidence }> {
    const pack = await computeSourcePack(this.plan.targetRevision);
    await verifySourceReview(this.reviewPath, { sourceManifestSha256: this.plan.sourceManifestSha256,
      actualSourceReviewSha256: this.plan.actualSourceReviewSha256, mode: "owned" });
    if (this.rootBeforeBatch === null) this.rootBeforeBatch = (await readActivation(this.host.stateRoot)).record.rootSha256;
    await this.child({ op: "healthcheck-sample", pgDataDirectory: this.host.pgDataDirectory }, { database: "source", signal });
    const jobs = units.map(u => u.generation.jobRunId);
    const ev = await this.child({ op: "evidence", databaseBudgetBytes: this.host.databaseBudgetBytes, expectedRole: this.host.role,
      knownApplicationNames: this.host.knownApplicationNames, jobRunIds: jobs }, { database: "source", signal });
    let rows = 0, contexts = 0, archiveBytes = 0, copies = units.length > 0, restores = units.length > 0;
    for (const u of units) {
      const config = await this.frozenConfig(u), c = await this.copiesMatch(u), r = await this.state(u, "restore.json");
      copies &&= c.ok; restores &&= r?.frozenProofParity === true;
      archiveBytes += c.bytes;
      if (c.ok) { rows = Math.max(rows, c.population === config.evaluations ? config.evaluations : -1); contexts = Math.max(contexts, config.contexts); }
      else {
        const m = (ev.metadata as { id: string; n: number; contexts: number }[]).find(x => x.id === u.generation.jobRunId);
        rows = Math.max(rows, m?.n ?? 0); contexts = Math.max(contexts, m?.contexts ?? 0);
      }
    }
    const active = (await readActivation(this.host.stateRoot)).record.rootSha256;
    const expectedRoot = this.activated ? this.publishedRoot : this.rootBeforeBatch;
    let http = false, pins = false;
    if (operation === "retire-original") {
      // ONLY an actual HTTP 200 complete-body proof counts; never a reader function call.
      http = (await Promise.all(units.map(u => this.retireHttpProof(u, active, signal)))).every(p => p.matches === true);
      const p = await Promise.all(units.map(async u => (await this.child({ op: "pins", config: await this.frozenConfig(u),
        proofSha256: u.originalProofSha256 }, { database: "source", signal })).selectedPinClosureMatches === true));
      pins = p.every(Boolean);
    }
    const app = await statfs(this.paths.archive), wal = await statfs(this.host.pgDataDirectory);
    const observedAt = new Date().toISOString();
    const evidence: NativeStorageMaintenanceEvidence = { operation, observedAt,
      sourceManifestSha256: pack.sourceManifestSha256, actualSourceReviewSha256: this.plan.actualSourceReviewSha256,
      sourceMatches: pack.sourceManifestSha256 === this.plan.sourceManifestSha256,
      exactRolesAndReaderRootMatch: ev.facts.roleMatches === true && active === expectedRoot,
      unknownDatabaseConsumers: ev.facts.unknownDatabaseConsumers, nativeProducerIdle: ev.facts.nativeProducerIdle === true,
      originalRows: rows, originalContexts: contexts, serializedArchiveBytes: archiveBytes,
      appVolume: { observedAt, availableBytes: app.bavail * app.bsize, minimumFreeBytes: 2 * GiB },
      walVolume: { observedAt, availableBytes: wal.bavail * wal.bsize, minimumFreeBytes: 2 * GiB },
      independentOriginalRestoreMatches: restores, completeOriginalCopiesMatch: copies,
      freshHistoricalHttpMatches: http, selectedPinClosureMatches: pins,
      alreadyAbsentWithEnforcedLineage: ev.facts.lineage.absent === true };
    return { business: ev.business as DbGrowthFenceDecision, evidence };
  }

  private async receipt(stage: NativeStorageStage, units: NativeStorageBatchUnit[], evidence: Record<string, unknown>,
    acknowledged: boolean, bytesMatch: boolean): Promise<NativeStorageStageReceipt> {
    const dir = join(this.batchDir, "stages"); await mkdir(dir, { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify({ contract: "finite-native-storage-stage-evidence.v1", purpose: this.plan.purpose, stage,
      jobRunIds: units.map(u => u.generation.jobRunId), at: new Date().toISOString(), ...evidence });
    const evidenceSha256 = await writeExclusive(join(dir, `${pad(++this.stageSequence)}-${stage}.json`), bytes);
    return { purpose: this.plan.purpose, stage, jobRunIds: units.map(u => u.generation.jobRunId), actualExitCode: acknowledged && bytesMatch ? 0 : 1,
      actionAcknowledged: acknowledged, independentFullOriginalBytesMatch: bytesMatch, providerAuthority: false, reclaimedBytes: 0, evidenceSha256 };
  }
  private async allCopies(units: NativeStorageBatchUnit[]) {
    for (const u of units) if (!(await this.copiesMatch(u)).ok) return false;
    return true;
  }

  async execute(stage: NativeStorageStage, units: NativeStorageBatchUnit[], signal: AbortSignal): Promise<NativeStorageStageReceipt> {
    switch (stage) {
      case "capture-restore": {
        const u = units[0]!, config = await this.frozenConfig(u);
        await mkdir(this.unitDir(u), { recursive: true, mode: 0o700 });
        await mkdir(this.copyDir(u), { recursive: true, mode: 0o700 }); await privateDirectory(this.copyDir(u));
        const captured = await this.child({ op: "capture", capture: { generation: u.generation, expectedEvaluations: u.evaluations,
          expectedContexts: u.contexts, sourceRevision: this.plan.targetRevision, consumerInventorySha256: config.consumerInventorySha256 },
          frozenProofSha256: u.originalProofSha256, keyFile: join(this.paths.keys, `${this.host.keyId}.key`), keyId: this.host.keyId,
          archiveRoot: this.paths.archive, copyDirectory: this.copyDir(u) }, { database: "source", signal });
        await writeExclusive(join(this.unitDir(u), "capture.json"), JSON.stringify(captured));
        const index = this.plan.units.findIndex(x => x.generation.jobRunId === u.generation.jobRunId);
        const restored = await this.child({ op: "restore", config, proofSha256: u.originalProofSha256,
          keyFile: join(this.paths.keys, `${this.host.keyId}.key`), archiveRoot: this.paths.archive, copyDirectory: this.copyDir(u),
          // A NEW database per purpose+unit; never reused across batches.
          restoreDatabase: `nsb_restore_${this.plan.purpose}_${String(index).padStart(2, "0")}`, templateDatabase: this.host.restore.template },
          { database: "restore-admin", signal });
        await writeExclusive(join(this.unitDir(u), "restore.json"), JSON.stringify(restored));
        const match = restored.frozenProofParity === true && (await this.copiesMatch(u)).ok;
        return this.receipt(stage, units, { captureProofSha256: captured.metadata.proofSha256, parts: captured.metadata.parts.length,
          coverageRootSha256: captured.metadata.coverageRootSha256, leafSha256: captured.metadata.leafSha256,
          restoreTableHashes: restored.tableHashes }, true, match);
      }
      case "publish": {
        const before = (await readActivation(this.host.stateRoot)).record;
        const load = (kind: NativeHistoricalMetadataKind, sha256: string, maxBytes: number) =>
          readLocalNativeHistoricalMetadata(this.paths.routing, { kind, sha256, maxBytes });
        const rootBytes = await load("root", before.rootSha256, NATIVE_HISTORICAL_ROUTING_BOUNDS.rootBytes);
        const root = JSON.parse(rootBytes.toString("utf8"));
        need(root.legacy.sha256 === this.host.legacySha256, "EXACT_RETAINED_LEGACY");
        const legacy = await load("legacy", root.legacy.sha256, NATIVE_HISTORICAL_ROUTING_BOUNDS.legacyBytes);
        const oldRecords: { generation: { jobRunId: string }; leaf: { sha256: string; bytes: number } }[] = [];
        const leaves: { content: Buffer; sha256: string }[] = [];
        for (const s of root.shards as { sha256: string }[]) {
          const shard = JSON.parse((await load("shard", s.sha256, NATIVE_HISTORICAL_ROUTING_BOUNDS.shardBytes)).toString("utf8"));
          for (const r of shard.records) { oldRecords.push(r); leaves.push({ content: await load("leaf", r.leaf.sha256, NATIVE_HISTORICAL_ROUTING_BOUNDS.leafBytes), sha256: r.leaf.sha256 }); }
        }
        const fresh: { jobRunId: string; leafSha256: string }[] = [];
        for (const u of units) {
          const capture = await this.state(u, "capture.json"); need(capture, "CAPTURE_STATE_REQUIRED");
          const content = await readExact(join(this.copyDir(u), `leaf-${capture.metadata.leafSha256}.json`), NATIVE_HISTORICAL_ROUTING_BOUNDS.leafBytes);
          need(sha256(content) === capture.metadata.leafSha256, "ROOT_OR_CIPHER_COPY_MISMATCH");
          leaves.push({ content, sha256: capture.metadata.leafSha256 }); fresh.push({ jobRunId: u.generation.jobRunId, leafSha256: capture.metadata.leafSha256 });
        }
        // ONE complete immutable root per batch: legacy + every prior leaf + every new leaf.
        const publication = buildNativeHistoricalCatalogRouting({ legacy: { content: legacy, sha256: root.legacy.sha256 }, leaves });
        await persistLocalNativeHistoricalRouting(this.paths.routing, publication);
        const router = new NativeHistoricalCatalogRouter(); let routes = 0;
        for (const u of units) {
          const capture = await this.state(u, "capture.json");
          for (const p of capture.metadata.parts as { ciphertextSha256: string; firstEvaluationId: string; lastEvaluationId: string }[])
            for (const evaluationId of [p.firstEvaluationId, p.lastEvaluationId]) {
              const resolved = await router.resolve({ generation: u.generation, evaluationId, providerAccountId: "metadata-probe", adId: "metadata-probe" },
                { rootSha256: publication.root.sha256, legacySha256: root.legacy.sha256, readerAssetSha256: "0".repeat(64), directory: this.paths.routing },
                (ref, s) => readLocalNativeHistoricalMetadata(this.paths.routing, ref, s));
              need(resolved.entry.ciphertextSha256 === p.ciphertextSha256, "CORRECT_ORIGINAL_PART_ROUTE"); routes++;
            }
        }
        const after = JSON.parse((await load("root", publication.root.sha256, NATIVE_HISTORICAL_ROUTING_BOUNDS.rootBytes)).toString("utf8"));
        const newRecords: typeof oldRecords = [];
        for (const s of after.shards) newRecords.push(...JSON.parse((await load("shard", s.sha256, NATIVE_HISTORICAL_ROUTING_BOUNDS.shardBytes)).toString("utf8")).records);
        const superset = after.legacy.sha256 === root.legacy.sha256 && same(after.legacy.jobRunIds, root.legacy.jobRunIds) &&
          oldRecords.every(o => newRecords.some(n => same(n, o))) && newRecords.length === oldRecords.length + units.length;
        need(superset, "COMPLETE_ROOT_SUPERSET_REQUIRED");
        this.publishedRoot = publication.root.sha256;
        await writeExclusive(join(this.batchDir, "publication.json"), JSON.stringify({ purpose: this.plan.purpose,
          previousRootSha256: before.rootSha256, rootSha256: publication.root.sha256, rootBytes: publication.root.bytes, fresh }));
        return this.receipt(stage, units, { previousRootSha256: before.rootSha256, rootSha256: publication.root.sha256,
          retainedPriorRecords: oldRecords.length, newLeaves: fresh, exactPartRoutes: routes }, true, superset && await this.allCopies(units));
      }
      case "activate": {
        need(this.publishedRoot, "PUBLICATION_REQUIRED");
        const current = await readActivation(this.host.stateRoot);
        // Once per batch: EXCL purpose marker + next immutable activation record.
        await writeExclusive(join(this.paths.activation, `purpose-${this.plan.purpose}.json`), JSON.stringify({ rootSha256: this.publishedRoot }));
        await writeExclusive(join(this.paths.activation, `${pad(current.sequence + 1)}.json`), JSON.stringify({
          contract: "native-storage-root-activation.v1", purpose: this.plan.purpose, rootSha256: this.publishedRoot,
          previousRootSha256: current.record.rootSha256, imageRevision: this.plan.targetRevision,
          sourceManifestSha256: this.plan.sourceManifestSha256, activatedAt: new Date().toISOString() }));
        this.activated = true;
        const reads = await this.freshReads(this.plan.units, this.publishedRoot);
        return this.receipt(stage, units, { rootSha256: this.publishedRoot, newWebProcessReads: reads.reads,
          servingCheck: "reader_function_in_fresh_process_not_http",
          workerSha256: reads.workerSha256, sameImageSource: reads.sameImageSource, newWebOwnObservationRequired: true },
          reads.sameImageSource, reads.matches && await this.allCopies(units));
      }
      case "retire": {
        const u = units[0]!, config = await this.frozenConfig(u);
        let challengeSent = false;
        const result = await this.child({ op: "retire", config, proofSha256: u.originalProofSha256, unitLockKey: unitLockKey(u.generation.jobRunId),
          producerLockKey: producerExclusionKey(u.generation) },
          { database: "source", signal, onLine: async (line, write, kill) => {
            need(line.type === "prepared" && !challengeSent, "UNEXPECTED_CHILD_PROTOCOL");
            const { acceptPrepared } = await import("./retire");
            acceptPrepared(line.prepared, config);
            await this.journal?.note({ commitChallenge: { jobRunId: u.generation.jobRunId, preparedSha256: line.preparedSha256 } });
            challengeSent = true;
            write({ action: "COMMIT_EXACT_UNIT_ONCE", preparedSha256: line.preparedSha256, challengeNonce: line.challengeNonce,
              proofSha256: u.originalProofSha256 });
            if (this.faults.dropReplyAfterCommitChallenge === u.generation.jobRunId) { kill(); return true; }
          } }).catch(error => {
            if (challengeSent) throw new BatchRefusal("RETIRE_COMMIT_AMBIGUOUS_STATUS_ONLY");
            throw error;
          });
        need(result.committed === true, "ACTUAL_COMMIT_ACK_REQUIRED");
        return this.receipt(stage, units, { committed: true, preparedSha256: result.preparedSha256 }, true, await this.allCopies(units));
      }
      case "independent-readback": {
        const u = units[0]!, config = await this.frozenConfig(u);
        const back = await this.child({ op: "readback", config, proofSha256: u.originalProofSha256 }, { database: "source", signal });
        const reads = await this.freshReads(units, (await readActivation(this.host.stateRoot)).record.rootSha256);
        return this.receipt(stage, units, { exactUnitAbsent: back.exactUnitAbsent, retainedRootsFullBytesMatch: back.retainedRootsFullBytesMatch,
          archivedOriginalServedAfterRetirement: reads.matches, servingCheck: "reader_function_in_fresh_process_not_http" }, back.exactUnitAbsent === true,
          back.retainedRootsFullBytesMatch === true && reads.matches && await this.allCopies(units));
      }
      case "vacuum-main": {
        const v = await this.child({ op: "vacuum", component: "main", jobRunIds: units.map(u => u.generation.jobRunId) }, { database: "source", signal });
        return this.receipt(stage, units, { component: "main", acknowledged: v.acknowledged, elapsedMs: v.elapsedMs }, v.acknowledged === true, await this.allCopies(units));
      }
      case "toast-observation": {
        const o = await this.child({ op: "toast-observation" }, { database: "source", signal });
        return this.receipt(stage, units, toastObservationEvidence(o), toastObservationAcknowledged(o), await this.allCopies(units));
      }
      // History-only v1 stage name: a v2 plan never schedules it and this operator never runs it.
      case "vacuum-toast": throw new BatchRefusal("VACUUM_TOAST_STAGE_RETIRED");
      case "space-readback": {
        const s = await this.child({ op: "space" }, { database: "source", signal });
        return this.receipt(stage, units, { relations: s.relations, reclaimedBytes: 0 }, true, await this.allCopies(units));
      }
    }
  }
}

export const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
