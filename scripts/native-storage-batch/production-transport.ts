import { spawn } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { nativeStorageBatchSchedule, nativeStoragePlanDigest, type NativeStorageBatchBackend, type NativeStorageBatchPlan, type NativeStorageBatchUnit,
  type NativeStorageStage, type NativeStorageStageReceipt } from "../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import type { NativeStorageMaintenanceEvidence, NativeStorageOperation } from "../../lib/sync/native-storage-maintenance-admission";
import type { DbGrowthFenceDecision } from "../../lib/sync/db-growth-fence";
import { NATIVE_HISTORICAL_ROUTING_BOUNDS } from "../../lib/creative-decision-engine/native-historical-catalog-routing";
import { openImmutableNativeHistoricalArchiveCatalog, type NativeHistoricalArchiveContentTrust } from "../../lib/creative-decision-engine/native-historical-archive";
import { BatchRefusal, canonicalSha, need, pad, privateDirectory, readExact, same, sha256, writeExclusive } from "./common";
import { computeSourcePack, REPO_ROOT, TSX_LOADER, verifySourceReview } from "./source-pack";
import { evidencePath, verifyHttpProof, type Sample } from "./http-proof";
import { persistPrivateCopy, verifyPrivateCopies, type CaptureMetadata, type UnitConfig } from "./capture";
import { databaseUrl, unitLockKey } from "./backend";
import { toastObservationAcknowledged, toastObservationEvidence } from "./maintenance";

/** PRODUCTION TRANSPORT. Fixed allowlist: two hosts, one reviewed actor, one
 * digest-bound stage bundle, the actor's closed op set. Every source-bound
 * handshake is implemented here and in production-actor.py: held-key capture
 * with encrypted-only egress, two private copies, independent operator-private
 * full-DDL restore, immutable superset root publisher, same-image web-only
 * activation, C3 retirement, separate S main/TOAST maintenance, the existing
 * DB-host sampler. Nothing is sent unless the transport is armed for the exact
 * purpose; nothing in this change was executed against production. */
export const APP_SSH_TARGET = "root@178.156.222.119";
export const DB_SSH_TARGET = "root@87.99.149.56";
export const ACTOR_FILE = join(REPO_ROOT, "scripts/native-storage-batch/production-actor.py");
export const STAGE_ENTRY_FILE = join(REPO_ROOT, "scripts/native-storage-batch/stage-entry.ts");
export const HUMAN_AUTHORITY_SHA256 = "79ee0d9d813bb78152a0c3c7df9b653cf7d3b7ad90ee0c6b607a0e54ad2c4358";
export const ARCHIVE_MOUNT = "/run/adsecute-native-archive";
export const BOOTSTRAP_SOURCE = "const fs=require('fs'),c=require('crypto'),M=require('module');const w=process.argv[1],n=Number(process.argv[2]);" +
  "if(!/^[a-f0-9]{64}$/.test(w)||!Number.isSafeInteger(n)||n<1||n>8388608)process.exit(70);" +
  "const b=Buffer.alloc(n);let o=0;const s=new Int32Array(new SharedArrayBuffer(4));" +
  "while(o<n){try{const r=fs.readSync(0,b,o,n-o,null);if(r===0)process.exit(71);o+=r;}" +
  "catch(e){if(e.code!=='EAGAIN')process.exit(72);Atomics.wait(s,0,0,5);}}" +
  "if(c.createHash('sha256').update(b).digest('hex')!==w)process.exit(73);" +
  "const m=new M('/nsb-stage-bundle.cjs');m.filename='/nsb-stage-bundle.cjs';m.paths=M._nodeModulePaths(process.cwd());" +
  "m._compile(b.toString('utf8'),'/nsb-stage-bundle.cjs');";
const MiB = 1024 * 1024, GiB = 1024 * MiB;

/** Deterministic single-file CJS bundle of the reviewed stage entry. */
export async function buildStageBundle(outDirectory: string) {
  const { build } = await import(join(REPO_ROOT, "node_modules/esbuild/lib/main.js")) as typeof import("esbuild");
  await mkdir(outDirectory, { recursive: true, mode: 0o700 });
  const outfile = join(outDirectory, "stage-bundle.cjs");
  const result = await build({ entryPoints: [STAGE_ENTRY_FILE], outfile, bundle: true, platform: "node", target: "node20", format: "cjs",
    absWorkingDir: REPO_ROOT, tsconfig: join(REPO_ROOT, "tsconfig.json"), external: ["pg-native", "@aws-sdk/client-s3"],
    logLevel: "error", metafile: true, minify: false, legalComments: "none" });
  const source = await readFile(outfile);
  need(source.length > 0 && source.length <= 8 * MiB, "BOUNDED_STAGE_BUNDLE");
  return { source: source.toString("utf8"), sha256: sha256(source), bytes: source.length, inputs: Object.keys(result.metafile!.inputs).length };
}

export interface RoleIdentity { containerId: string; imageId: string; repoDigest: string; startedAt: string; otherEnvSha256: string; mountsSha256: string }
export interface ProductionPrestate {
  contract: "native-storage-production-prestate.v1"; observedAt: string; runtimeRevision: string;
  roles: { web: RoleIdentity; worker: RoleIdentity }; composeModelSha256: string;
  globalConfigHashes: Record<".env" | ".env.production" | "docker-compose.override.yml", string>;
  archiveEnvSha256: string; activeRoot: { sha256: string; name: string }; runtimeSourceHashes: Record<string, string>;
  webBaselineAfterOwnActivation?: { containerId: string; startedAt: string };
  /** Explicit compose binding: runtime-only pins and each role's pinned image ref
   * resolved to its running image id/digest with the predicted env matching. */
  compose: ComposeBinding;
}
export interface ComposeRoleBinding { ref: string; pinnedRef: boolean; resolvedImageId: string | null; imageMatches: boolean;
  predictedEnvMatches: boolean; matches: boolean }
export interface ComposeBinding { pins: { APP_IMAGE_TAG: string; APP_BUILD_ID: string };
  roles: { web: ComposeRoleBinding; worker: ComposeRoleBinding }; globalEnvPinKeysEqualRuntime: { APP_IMAGE_TAG: boolean; APP_BUILD_ID: boolean } }
export interface ProductionHostConfig {
  contract: "native-storage-production-host.v2"; mode: "production";
  /** Operator-local private directory: journal, frozen configs, both private copies, proofs, private restore cluster. */
  stateRoot: string;
  /** Operator source revision (= plan.targetRevision) and live runtime image revision, never conflated. */
  operatorRevision: string; runtimeRevision: string;
  /** Fresh read-only prestate frozen by the root operator before execution (file + digest). */
  prestate: { path: string; sha256: string };
  /** Reviewed runtime source manifest (/app/... → sha256), e.g. the 63-file set. */
  runtimeSourceManifest: { path: string; sha256: string };
  /** Existing held key: the HOST copy is read only by the root actor; these operator copies are only for local verification/restore. */
  heldKey: { keyId: string; sha256: string; primaryPath: string; recoveryPath: string };
  privateRestore: { socketDirectory: string; port: number; template: string; role: string };
  role: string; knownApplicationNames: string[]; databaseBudgetBytes: number;
}
export function validateProductionHost(h: ProductionHostConfig) {
  need(h?.contract === "native-storage-production-host.v2" && h.mode === "production", "EXACT_PRODUCTION_HOST_CONFIG");
  need(/^[a-f0-9]{40}$/.test(h.operatorRevision) && /^[a-f0-9]{40}$/.test(h.runtimeRevision), "SPLIT_OPERATOR_AND_RUNTIME_REVISIONS");
  need(/^[a-f0-9]{64}$/.test(h.prestate?.sha256) && /^[a-f0-9]{64}$/.test(h.runtimeSourceManifest?.sha256) &&
    /^[a-f0-9]{64}$/.test(h.heldKey?.sha256) && /^[a-zA-Z0-9._-]{1,80}$/.test(h.heldKey?.keyId), "EXACT_BOUND_DIGESTS");
  need(Number.isSafeInteger(h.databaseBudgetBytes) && h.databaseBudgetBytes > 0 && /^[a-z_][a-z0-9_]{0,62}$/.test(h.role) &&
    Array.isArray(h.knownApplicationNames) && h.knownApplicationNames.length <= 32, "EXACT_PRODUCTION_HOST_CONFIG");
  for (const dir of [h.privateRestore?.socketDirectory, h.heldKey.primaryPath, h.heldKey.recoveryPath])
    need(typeof dir === "string" && dir.startsWith("/") && !dir.includes(".."), "ABSOLUTE_OPERATOR_PATHS");
  need(h.privateRestore.socketDirectory.startsWith(`${h.stateRoot}/`) && /^nsb_restore_[a-f0-9]{12}$/.test(h.privateRestore.template), "OPERATOR_PRIVATE_RESTORE_SCOPE");
  return h;
}
export async function loadProductionHost(path: string) {
  const host = validateProductionHost(JSON.parse((await readExact(path, 256 * 1024)).toString("utf8")));
  await privateDirectory(host.stateRoot);
  return host;
}
export async function loadPrestate(host: ProductionHostConfig) {
  const bytes = await readExact(host.prestate.path, 1024 * 1024), manifest = await readExact(host.runtimeSourceManifest.path, 1024 * 1024);
  need(sha256(bytes) === host.prestate.sha256 && sha256(manifest) === host.runtimeSourceManifest.sha256, "EXACT_FROZEN_PRESTATE_AND_RUNTIME_MANIFEST");
  const prestate = JSON.parse(bytes.toString("utf8")) as ProductionPrestate, runtime = JSON.parse(manifest.toString("utf8"));
  need(prestate.contract === "native-storage-production-prestate.v1" && prestate.runtimeRevision === host.runtimeRevision &&
    same(prestate.runtimeSourceHashes, runtime.files ?? runtime), "PRESTATE_BOUND_TO_RUNTIME_MANIFEST");
  need(prestate.roles.web.imageId !== undefined && prestate.roles.worker.imageId !== undefined, "PER_ROLE_IMAGE_IDENTITY");
  return prestate;
}

export type ActorHost = "app" | "db";
export interface ActorTransport { readonly kind: "ssh" | "fixture"; send(host: ActorHost, payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<any> }
const shellQuote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
/** Fixed argv per host; payload on stdin; one bounded JSON receipt. A lost or
 * garbled reply after dispatch is ambiguous → status-only, never resent. */
export class ProductionSshTransport implements ActorTransport {
  readonly kind = "ssh" as const;
  constructor(private readonly armedPurpose: string | null) {}
  async send(host: ActorHost, payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
    need(this.armedPurpose !== null && payload.purpose === this.armedPurpose, "PRODUCTION_TRANSPORT_NOT_ARMED_FOR_PURPOSE");
    return runActor(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=7",
      host === "app" ? APP_SSH_TARGET : DB_SSH_TARGET], payload, timeoutMs, undefined, signal);
  }
}
/** Shared bounded actor runner (ssh in production; local python in fixtures). */
export async function runActor(prefix: string[], payload: Record<string, unknown>, timeoutMs: number, env?: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const actor = await readFile(ACTOR_FILE, "utf8"), raw = Buffer.from(JSON.stringify(payload));
  need(raw.length <= 12 * MiB && actor.length <= 96 * 1024, "BOUNDED_ACTOR_TRANSPORT");
  return new Promise<any>((resolve, reject) => {
    const argv = prefix[0] === "ssh" ? [...prefix, `python3 -c ${shellQuote(actor)}`] : [...prefix, "-c", actor];
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], env });
    let out = Buffer.alloc(0), done = false;
    const finish = (e: Error | null, v?: unknown) => { if (done) return; done = true; clearTimeout(timer); if (e) reject(e); else resolve(v); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new BatchRefusal("ACTOR_TRANSPORT_DEADLINE_STATUS_ONLY")); }, timeoutMs);
    signal?.addEventListener("abort", () => { child.kill("SIGKILL"); finish(new BatchRefusal("ACTOR_TRANSPORT_ABORTED_STATUS_ONLY")); }, { once: true });
    child.stdout.on("data", (c: Buffer) => { out = Buffer.concat([out, c]); if (out.length > 24 * MiB) { child.kill("SIGKILL"); finish(new BatchRefusal("BOUNDED_ACTOR_RECEIPT")); } });
    child.stderr.on("data", () => undefined);
    child.on("close", code => {
      try { finish(null, { ...JSON.parse(out.toString("utf8")), actualTransportExitCode: code }); }
      catch { finish(new BatchRefusal("ACTOR_RECEIPT_AMBIGUOUS_STATUS_ONLY")); }
    });
    child.on("error", () => finish(new BatchRefusal("ACTOR_TRANSPORT_SPAWN_FAILED")));
    child.stdin.end(raw);
  });
}

type Stage = NativeStorageStage | "plan" | "evidence" | "status";
/** One remote durable entry consumed by an execution stage, as recorded in the
 * local stage evidence and re-matched against the hosts' read-only listing. */
export interface RemoteRef { host: ActorHost; sequence: number; stage: string; op: string; stageOp: string | null;
  unitJobRunIds: string[]; subjectSha256s: string[]; requestSha256: string; resultSha256: string }
const isRef = (x: RemoteRef | undefined, host: ActorHost, op: string, stageOp: string | null) => x?.host === host && x.op === op && (x.stageOp ?? null) === stageOp;
/** The EXACT remote entry set each acknowledged stage must have consumed. */
const REQUIRED_REMOTE: Record<NativeStorageStage, (r: RemoteRef[]) => boolean> = {
  "capture-restore": r => r.length === 1 && isRef(r[0], "app", "db", "capture"),
  publish: r => r.length >= 2 && r.slice(0, -1).every(x => isRef(x, "app", "stage-cipher", null)) && isRef(r.at(-1), "app", "publish-root", null),
  activate: r => r.length === 1 && isRef(r[0], "app", "activate-root", null),
  retire: r => r.length === 1 && isRef(r[0], "app", "db", "retire"),
  "independent-readback": r => r.length === 1 && isRef(r[0], "app", "db", "readback"),
  "vacuum-main": r => r.length === 1 && isRef(r[0], "app", "db", "vacuum"),
  "toast-observation": r => r.length === 1 && isRef(r[0], "app", "db", "toast-observation"),
  // History-only v1 name: never verified as an acknowledged stage by this operator.
  "vacuum-toast": () => false,
  "space-readback": r => r.length === 1 && isRef(r[0], "app", "db", "space"),
};
const EVIDENCE_STAGE_OPS = ["evidence", "pins", "readback"];
/** Units a closed stage-bundle request itself names (the actor derives the same). */
export function requestUnitIds(request: any): string[] | null {
  const o = request?.op;
  if (o === "capture" || o === "freeze") return [request.capture?.generation?.jobRunId];
  if (o === "retire" || o === "readback" || o === "pins") return [request.config?.generation?.jobRunId];
  if (o === "evidence" || o === "vacuum") return [...(request.jobRunIds ?? [])];
  if (o === "select") return [];
  return null;
}
/** The selection/freeze prelude's declared immutable selection (selection.json,
 * write-once). It has its OWN digest; the final execution plan has another. */
export interface SelectionPrelude {
  contract: "native-storage-selection-prelude.v1"; purpose: string; operatorRevision: string; runtimeRevision: string;
  sourceManifestSha256: string; actualSourceReviewSha256: string; expectedDatabaseBudgetBytes: number; cutoffObservedAt: string;
  cursor: { asOfDate: string; jobRunId: string } | null; limit: number; maxUnits: number;
}
export async function loadSelection(stateRoot: string, plan: NativeStorageBatchPlan, runtimeRevision: string) {
  const bytes = await readExact(join(stateRoot, "batches", plan.purpose, "selection.json"), 64 * 1024);
  const d = JSON.parse(bytes.toString("utf8")) as SelectionPrelude;
  need(d.contract === "native-storage-selection-prelude.v1" && d.purpose === plan.purpose && d.operatorRevision === plan.targetRevision &&
    d.runtimeRevision === runtimeRevision && d.sourceManifestSha256 === plan.sourceManifestSha256 &&
    d.actualSourceReviewSha256 === plan.actualSourceReviewSha256 && d.expectedDatabaseBudgetBytes === plan.expectedDatabaseBudgetBytes &&
    d.cutoffObservedAt === plan.cutoffObservedAt && plan.units.length <= d.maxUnits, "PLAN_NOT_FROM_DECLARED_SELECTION");
  return { declaration: d, sha256: sha256(bytes) };
}

/** D149 amendment of the reviewed 1 s contract: the actual 2026-10-07 APP status receive lead was 2209 ms
 * while the coordinator measured ~2.8 s behind Apple NTP (APP/DB hosts NTP-synchronised). */
export const APP_SAMPLE_CLOCK_SETTLEMENT_MAX_MS = 5000;
/** Preserve the host's sample UTC and every admission threshold. A strictly positive host clock lead of at most
 * 5000 ms may settle by ONE real elapsed timer of at most 5000 ms, inside freshEvidence only, cancelled by the
 * stage/batch abort signal. Larger, invalid or stale samples (and a timer the clock has not caught up with) still go
 * unchanged to the existing fail-closed assessor. No clock offset, Date override or normalization is applied. */
export async function settleAppSampleClock(observedAt: string, hooks: {
  now?: () => number; sleep?: (milliseconds: number) => Promise<void>; signal?: AbortSignal;
} = {}): Promise<void> {
  const now = hooks.now ?? Date.now, lead = Date.parse(observedAt) - now();
  if (!Number.isFinite(lead) || lead <= 0 || lead > APP_SAMPLE_CLOCK_SETTLEMENT_MAX_MS) return;
  const signal = hooks.signal;
  need(!signal?.aborted, "CLOCK_SETTLEMENT_ABORTED");
  const sleep = hooks.sleep ?? ((milliseconds: number) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new BatchRefusal("CLOCK_SETTLEMENT_ABORTED")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  }));
  await sleep(Math.min(APP_SAMPLE_CLOCK_SETTLEMENT_MAX_MS, Math.ceil(lead) + 1));
  need(!signal?.aborted, "CLOCK_SETTLEMENT_ABORTED");
}

export class ProductionHostBatchBackend implements NativeStorageBatchBackend {
  private bundle: Awaited<ReturnType<typeof buildStageBundle>> | null = null;
  private sequences: Record<ActorHost, number | null> = { app: null, db: null };
  private expect: ProductionPrestate | null = null;
  private stageSequence = 0;
  private remoteListing: Record<ActorHost, any[]> = { app: [], db: [] };
  /** Explicit phase: the prelude carries ONLY its declared selection digest, execution ONLY the final plan digest. */
  private readonly identity: { phase: "selection-prelude"; selectionSha256: string } | { phase: "execution"; planSha256: string };
  private currentStage: NativeStorageStage | null = null;
  private stageRemote: RemoteRef[] = [];
  constructor(private readonly host: ProductionHostConfig, private readonly plan: NativeStorageBatchPlan,
    private readonly reviewPath: string, private readonly transport: ActorTransport,
    prelude: { declaration: SelectionPrelude; sha256: string } | null = null) {
    validateProductionHost(host);
    need(host.databaseBudgetBytes === plan.expectedDatabaseBudgetBytes, "BUDGET_IS_HOST_CONFIG_NOT_OVERRIDE");
    need(host.operatorRevision === plan.targetRevision, "PLAN_IS_OPERATOR_REVISION_RUNTIME_IS_SEPARATE");
    if (prelude) {
      const d = prelude.declaration;
      need(plan.units.length === 0 && sha256(JSON.stringify(d)) === prelude.sha256 && d.purpose === plan.purpose &&
        d.operatorRevision === plan.targetRevision && d.runtimeRevision === host.runtimeRevision && d.sourceManifestSha256 === plan.sourceManifestSha256 &&
        d.actualSourceReviewSha256 === plan.actualSourceReviewSha256, "EXPLICIT_SELECTION_PRELUDE");
      this.identity = { phase: "selection-prelude", selectionSha256: prelude.sha256 };
    } else this.identity = { phase: "execution", planSha256: nativeStoragePlanDigest(plan) };
  }
  private execution() { need(this.identity.phase === "execution", "EXECUTION_REQUIRES_FINAL_PLAN"); return nativeStoragePlanDigest(this.plan); }
  private batchDir() { return join(this.host.stateRoot, "batches", this.plan.purpose); }
  private unitDir(u: NativeStorageBatchUnit) { return join(this.batchDir(), "units", u.generation.jobRunId); }
  private copyDirs(u: NativeStorageBatchUnit): [string, string] {
    const base = join(this.host.stateRoot, "copies", this.plan.purpose, u.generation.jobRunId);
    return [join(base, "primary"), join(base, "recovery")];
  }
  async frozenConfig(u: NativeStorageBatchUnit): Promise<UnitConfig> {
    const c = JSON.parse((await readExact(join(this.batchDir(), "units", `${u.generation.jobRunId}.config.json`), 4 * MiB)).toString("utf8")) as UnitConfig;
    need(canonicalSha(c) === u.originalProofSha256 && same(c.generation, u.generation), "EXACT_FROZEN_UNIT_CONFIG"); return c;
  }
  private async local(name: string) {
    return readExact(join(this.batchDir(), name), 16 * MiB).then(b => JSON.parse(b.toString("utf8")), () => null);
  }
  private async expected() {
    if (!this.expect) {
      this.expect = await loadPrestate(this.host);
      const activation = await this.local("activation.json");
      if (activation) Object.assign(this.expect, { activeRoot: activation.activeRoot, archiveEnvSha256: activation.newArchiveEnvSha256,
        webBaselineAfterOwnActivation: { containerId: activation.newWebBaseline.containerId, startedAt: activation.newWebBaseline.startedAt } });
    }
    return this.expect;
  }
  async stageBundle() { this.bundle ??= await buildStageBundle(join(this.batchDir(), "bundle")); return this.bundle; }

  /** Restores the next remote sequence from the hosts' read-only status; a
   * consumed marker is never reissued (the actor refuses non-monotone numbers). */
  async syncRemote(signal?: AbortSignal) {
    for (const host of ["app", "db"] as const) {
      if (this.sequences[host] !== null) continue;
      const st = await this.send(host, host === "app" ? "status" : "db-status", "status", {}, 30_000, signal);
      const seq = st.sequence as { sequence: number; stage: string; op: string; receipt: { actualExitCode: number; statusReadOnlyRequired: boolean } | null }[];
      need(Array.isArray(seq) && seq.every(e => e.receipt !== null && !e.receipt.statusReadOnlyRequired), "REMOTE_STAGE_UNACKNOWLEDGED_OR_AMBIGUOUS_STATUS_ONLY");
      this.sequences[host] = seq.length; this.remoteListing[host] = seq;
    }
  }
  async payload(host: ActorHost, op: string, stage: Stage, extra: Record<string, unknown>) {
    const p: Record<string, unknown> = { contract: "native-storage-production-stage.v2", humanAuthoritySha256: HUMAN_AUTHORITY_SHA256, host,
      purpose: this.plan.purpose, operatorRevision: this.host.operatorRevision, runtimeRevision: this.host.runtimeRevision,
      sourceManifestSha256: this.plan.sourceManifestSha256, actualSourceReviewSha256: this.plan.actualSourceReviewSha256,
      ...this.identity, op, stage, sequence: 0, ...extra };
    if (op === "db" && p.unitJobRunIds === undefined) { const ids = requestUnitIds(extra.request); if (ids) p.unitJobRunIds = ids; }
    if (host === "app" && op !== "status") p.prestate = await this.expected();
    if (op === "db" || op === "publish-root") {
      const b = await this.stageBundle();
      Object.assign(p, { stageBundleSource: b.source, stageBundleSha256: b.sha256, bootstrapSource: BOOTSTRAP_SOURCE });
    }
    return p;
  }
  /** One actor call. Non-status calls take the next remote sequence; the
   * metadata receipt (no ciphertext/leaf bodies) is kept locally write-once.
   * The digest of the exact request bytes must come back from the remote
   * durable intent/receipt; an execution stage records every entry it consumed. */
  async send(host: ActorHost, op: string, stage: Stage, extra: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
    const status = op === "status" || op === "db-status";
    const p = await this.payload(host, op, stage, extra);
    if (!status) {
      need(this.sequences[host] !== null, "REMOTE_SEQUENCE_NOT_SYNCED"); need(Array.isArray(p.unitJobRunIds), "EXACT_UNIT_IDENTITY_REQUIRED");
      p.sequence = this.sequences[host]! + 1;
    }
    const raw = JSON.stringify(p), requestSha256 = sha256(raw);
    const r = await this.transport.send(host, JSON.parse(raw), timeoutMs, signal);
    if (!status) {
      this.sequences[host] = p.sequence as number;
      const dir = join(this.batchDir(), "remote"); await mkdir(dir, { recursive: true, mode: 0o700 });
      const kept = { ...r, localRequestSha256: requestSha256, result: r.result && { ...r.result, parts: undefined, leafBase64: undefined } };
      await writeExclusive(join(dir, `${host}-${pad(p.sequence as number)}-${stage}-${op}.json`), JSON.stringify(kept));
    }
    need(r.actualExitCode === 0 && r.actualTransportExitCode === 0, `PRODUCTION_ACTOR_REFUSED:${String(r.reason ?? "UNKNOWN").slice(0, 140)}`);
    if (!status) {
      need(r.requestSha256 === requestSha256 && r.sequence === p.sequence && r.purpose === this.plan.purpose && r.stage === stage && r.op === op &&
        r.phase === this.identity.phase && same(r.unitJobRunIds, p.unitJobRunIds) && /^[a-f0-9]{64}$/.test(r.resultSha256 ?? ""), "REMOTE_RECEIPT_REQUEST_ECHO");
      if (stage === this.currentStage) this.stageRemote.push({ host, sequence: p.sequence as number, stage, op, stageOp: r.stageOp ?? null,
        unitJobRunIds: p.unitJobRunIds as string[], subjectSha256s: r.subjectSha256s, requestSha256, resultSha256: r.resultSha256 });
    }
    return r;
  }
  /** Plan-time metadata-only selection / read-only freeze through the same fixed actor. */
  async planOp(request: Record<string, unknown>, signal?: AbortSignal) {
    need(this.identity.phase === "selection-prelude", "SELECTION_PRELUDE_ONLY");
    need(request.op === "select" || request.op === "freeze", "PLAN_OPS_ONLY");
    await this.syncRemote(signal);
    return (await this.db("plan", request, 170_000, signal)).result;
  }
  async status(extra: Record<string, unknown> = {}, signal?: AbortSignal) { return this.send("app", "status", "status", extra, 30_000, signal); }
  private db(stage: Stage, request: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal, extra: Record<string, unknown> = {}) {
    return this.send("app", "db", stage, { request, ...extra }, timeoutMs, signal);
  }
  private async heldKey() {
    const a = await readExact(this.host.heldKey.primaryPath, 32), b = await readExact(this.host.heldKey.recoveryPath, 32);
    need(a.length === 32 && a.equals(b) && sha256(a) === this.host.heldKey.sha256, "SEPARATE_ALREADY_HELD_RECOVERY_KEYS");
    b.fill(0); return a;
  }
  /** Byte-level check of both complete private encrypted copies. */
  private async copiesMatch(u: NativeStorageBatchUnit) {
    const capture = await this.local(`units/${u.generation.jobRunId}/capture.json`);
    if (!capture) return { ok: false, bytes: 0, population: 0 };
    const meta = capture.metadata as CaptureMetadata;
    let bytes = 0;
    try {
      for (const part of meta.parts) {
        const copies = await Promise.all(this.copyDirs(u).map(d => readExact(join(d, `${part.ciphertextSha256}.bin`), 2 * MiB + 128)));
        need(copies.every(c => sha256(c) === part.ciphertextSha256 && c.length === part.ciphertextBytes), "ROOT_OR_CIPHER_COPY_MISMATCH");
        bytes += part.ciphertextBytes;
      }
      const leaves = await Promise.all(this.copyDirs(u).map(d => readExact(join(d, `leaf-${meta.leafSha256}.json`), NATIVE_HISTORICAL_ROUTING_BOUNDS.leafBytes)));
      need(leaves.every(l => sha256(l) === meta.leafSha256), "ROOT_OR_CIPHER_COPY_MISMATCH");
      const catalog = openImmutableNativeHistoricalArchiveCatalog(leaves[0]!, meta.leafSha256);
      return { ok: true, bytes: bytes + leaves[0]!.length, population: new Set(catalog.entries.flatMap(e => e.segment!.evaluationIds)).size };
    } catch { return { ok: false, bytes: 0, population: 0 }; }
  }
  httpProofRoot() { return join(this.batchDir(), "http-proof"); }
  /** Retire admission: authenticated Chrome proof (fixture transport alone may
   * accept the owned HTTP fixture). Missing → PAUSE record, false, no intent. */
  private async retireHttpProof(u: NativeStorageBatchUnit, root: { sha256: string }) {
    const capture = await this.local(`units/${u.generation.jobRunId}/capture.json`), config = await this.frozenConfig(u);
    const activation = await this.local("activation.json");
    if (!capture || !activation) return false;
    const dir = join(this.httpProofRoot(), u.generation.jobRunId);
    const exists = await readExact(join(dir, "proof.json"), 256 * 1024).then(() => true, () => false);
    if (!exists) {
      await mkdir(this.httpProofRoot(), { recursive: true, mode: 0o700 });
      await writeExclusive(join(this.httpProofRoot(), `PAUSE-${u.generation.jobRunId}.json`), JSON.stringify({ contract: "native-storage-http-proof-pause.v1",
        purpose: this.plan.purpose, jobRunId: u.generation.jobRunId, rootSha256: root.sha256, actualSourceReviewSha256: this.plan.actualSourceReviewSha256,
        proofDirectory: `http-proof/${u.generation.jobRunId}`, requiredTransport: "chrome-authenticated",
        requests: (capture.samples as Sample[]).map(s => evidencePath(u.generation, s)) })).catch(() => undefined);
      return false;
    }
    return verifyHttpProof(dir, { purpose: this.plan.purpose, jobRunId: u.generation.jobRunId, rootSha256: root.sha256,
      sourceManifestSha256: this.plan.sourceManifestSha256, actualSourceReviewSha256: this.plan.actualSourceReviewSha256, generation: u.generation,
      samples: capture.samples as Sample[], rowSha256: config.evaluationRowSha256, activatedAt: activation.finishedAt, nowMs: Date.now(),
      allowOwnedFixture: this.transport.kind === "fixture" }).then(r => r.matches === true, () => false);
  }
  private rolesMatch(st: any, expect: ProductionPrestate) {
    const fields = ["containerId", "imageId", "repoDigest", "startedAt", "otherEnvSha256", "mountsSha256"] as const;
    const web = { ...expect.roles.web, ...(expect.webBaselineAfterOwnActivation ?? {}) };
    return fields.every(k => st.roles?.web?.[k] === web[k] && st.roles?.worker?.[k] === expect.roles.worker[k]) &&
      ["web", "worker"].every(r => st.roles[r].health === "healthy" && st.roles[r].buildId === this.host.runtimeRevision);
  }

  async freshEvidence(operation: NativeStorageOperation, units: NativeStorageBatchUnit[], signal?: AbortSignal): Promise<{
    business: DbGrowthFenceDecision; evidence: NativeStorageMaintenanceEvidence }> {
    this.execution();
    const pack = await computeSourcePack(this.plan.targetRevision, REPO_ROOT, this.host.runtimeRevision);
    await verifySourceReview(this.reviewPath, { sourceManifestSha256: this.plan.sourceManifestSha256,
      actualSourceReviewSha256: this.plan.actualSourceReviewSha256, mode: this.transport.kind === "fixture" ? "owned" : "production" });
    await this.syncRemote(signal);
    const expect = await this.expected();
    // The EXISTING DB-host sampler runs now; the fence then reads its DB-clock row (no cached value is relabelled).
    await this.send("db", "sample-capacity", "evidence", { unitJobRunIds: [] }, 90_000, signal);
    const ev = (await this.db("evidence", { op: "evidence", databaseBudgetBytes: this.host.databaseBudgetBytes, expectedRole: this.host.role,
      knownApplicationNames: this.host.knownApplicationNames, jobRunIds: units.map(u => u.generation.jobRunId) }, 60_000, signal)).result;
    const st = await this.send("app", "status", "status", {}, 30_000, signal);
    let rows = 0, contexts = 0, archiveBytes = 0, copies = true, restores = true;
    for (const u of units) {
      const config = await this.frozenConfig(u), c = await this.copiesMatch(u), r = await this.local(`units/${u.generation.jobRunId}/restore.json`);
      copies &&= c.ok; restores &&= r?.frozenProofParity === true && r?.plaintextRestoreDropped === true; archiveBytes += c.bytes;
      if (c.ok) { rows = Math.max(rows, c.population === config.evaluations ? config.evaluations : -1); contexts = Math.max(contexts, config.contexts); }
      else { const m = (ev.metadata as { id: string; n: number; contexts: number }[]).find(x => x.id === u.generation.jobRunId);
        rows = Math.max(rows, m?.n ?? 0); contexts = Math.max(contexts, m?.contexts ?? 0); }
    }
    let http = false, pins = false;
    if (operation === "retire-original") {
      http = (await Promise.all(units.map(u => this.retireHttpProof(u, expect.activeRoot)))).every(Boolean);
      const p = [];
      for (const u of units) p.push((await this.db("evidence", { op: "pins", config: await this.frozenConfig(u), proofSha256: u.originalProofSha256 }, 45_000, signal)).result.selectedPinClosureMatches === true);
      pins = p.every(Boolean);
    }
    await settleAppSampleClock(String(st.appVolume.observedAt), { signal });
    const business = ev.business as DbGrowthFenceDecision, physical = business.physical, observedAt = new Date().toISOString();
    const rootMatch = same(st.route, ["true", `${ARCHIVE_MOUNT}/${expect.activeRoot.name}`, expect.activeRoot.sha256]);
    return { business, evidence: { operation, observedAt, sourceManifestSha256: pack.sourceManifestSha256,
      actualSourceReviewSha256: this.plan.actualSourceReviewSha256, sourceMatches: pack.sourceManifestSha256 === this.plan.sourceManifestSha256,
      exactRolesAndReaderRootMatch: ev.facts.roleMatches === true && this.rolesMatch(st, expect) && rootMatch,
      unknownDatabaseConsumers: ev.facts.unknownDatabaseConsumers, nativeProducerIdle: ev.facts.nativeProducerIdle === true,
      originalRows: rows, originalContexts: contexts, serializedArchiveBytes: archiveBytes,
      appVolume: { observedAt: String(st.appVolume.observedAt), availableBytes: Number(st.appVolume.availableBytes), minimumFreeBytes: 2 * GiB },
      // WAL lives on the DB data volume: the fence's own just-sampled physical row (≤60 s required by admission).
      walVolume: { observedAt: physical?.sampledAt ?? "", availableBytes: physical?.availableBytes ?? -1, minimumFreeBytes: 2 * GiB },
      independentOriginalRestoreMatches: units.length > 0 && restores, completeOriginalCopiesMatch: units.length > 0 && copies,
      freshHistoricalHttpMatches: http, selectedPinClosureMatches: pins, alreadyAbsentWithEnforcedLineage: ev.facts.lineage?.absent === true } };
  }

  private async receipt(stage: NativeStorageStage, units: NativeStorageBatchUnit[], evidence: Record<string, unknown>, ack: boolean, bytes: boolean) {
    const dir = join(this.batchDir(), "stages"); await mkdir(dir, { recursive: true, mode: 0o700 });
    if (this.stageSequence === 0) this.stageSequence = (await readdir(dir)).length;
    const stageSequence = ++this.stageSequence;
    // Identity AFTER the stage facts: nothing stage-specific can overwrite it.
    const evidenceSha256 = await writeExclusive(join(dir, `${pad(stageSequence)}-${stage}.json`), JSON.stringify({ ...evidence,
      contract: "finite-native-storage-stage-evidence.v2", purpose: this.plan.purpose, stage, stageSequence, jobRunIds: units.map(u => u.generation.jobRunId),
      planSha256: this.execution(), sourceManifestSha256: this.plan.sourceManifestSha256, actualSourceReviewSha256: this.plan.actualSourceReviewSha256,
      operatorRevision: this.host.operatorRevision, runtimeRevision: this.host.runtimeRevision, remote: this.stageRemote, at: new Date().toISOString() }));
    return { purpose: this.plan.purpose, stage, jobRunIds: units.map(u => u.generation.jobRunId), actualExitCode: ack && bytes ? 0 : 1,
      actionAcknowledged: ack, independentFullOriginalBytesMatch: bytes, providerAuthority: false as const, reclaimedBytes: 0 as const, evidenceSha256 };
  }
  private async allCopies(units: NativeStorageBatchUnit[]) { for (const u of units) if (!(await this.copiesMatch(u)).ok) return false; return true; }

  async execute(stage: NativeStorageStage, units: NativeStorageBatchUnit[], signal: AbortSignal): Promise<NativeStorageStageReceipt> {
    this.execution();
    await this.syncRemote(signal);
    this.currentStage = stage; this.stageRemote = [];
    try { return await this.executeStage(stage, units, signal); } finally { this.currentStage = null; }
  }
  private async executeStage(stage: NativeStorageStage, units: NativeStorageBatchUnit[], signal: AbortSignal): Promise<NativeStorageStageReceipt> {
    const u = units[0]!, ids = units.map(x => x.generation.jobRunId);
    switch (stage) {
      case "capture-restore": {
        const config = await this.frozenConfig(u);
        const rec = await this.db(stage, { op: "capture", capture: { generation: u.generation, expectedEvaluations: u.evaluations,
          expectedContexts: u.contexts, sourceRevision: this.host.runtimeRevision, consumerInventorySha256: config.consumerInventorySha256 },
          frozenProofSha256: u.originalProofSha256 }, 170_000, signal, { heldKeySha256: this.host.heldKey.sha256, heldKeyId: this.host.heldKey.keyId });
        const out = rec.result, meta = out.metadata as CaptureMetadata;
        need(meta.proofSha256 === u.originalProofSha256 && same(meta.generation, u.generation) && out.parts.length === meta.parts.length, "EXACT_CAPTURED_ORIGINAL");
        const leaf = Buffer.from(out.leafBase64, "base64");
        const sealedParts = out.parts.map((p: { trustJson: string; ciphertextBase64: string }, i: number) => {
          const bytes = Buffer.from(p.ciphertextBase64, "base64"), trustBytes = Buffer.from(p.trustJson, "utf8"), expected = meta.parts[i]!;
          const trust = JSON.parse(p.trustJson) as NativeHistoricalArchiveContentTrust;
          need(sha256(bytes) === expected.ciphertextSha256 && bytes.length === expected.ciphertextBytes && trust.ciphertextSha256 === expected.ciphertextSha256 &&
            sha256(trustBytes) === expected.trustSha256, "ENCRYPTED_EGRESS_BYTES_MISMATCH");
          return { bytes, trust, trustBytes };
        });
        need(sha256(leaf) === meta.leafSha256, "ENCRYPTED_EGRESS_LEAF_MISMATCH");
        const [primary, recovery] = this.copyDirs(u);
        for (const d of [join(this.host.stateRoot, "copies"), join(this.host.stateRoot, "copies", this.plan.purpose), join(this.host.stateRoot, "copies", this.plan.purpose, u.generation.jobRunId)])
          await mkdir(d, { recursive: true, mode: 0o700 });
        await mkdir(primary, { mode: 0o700 }); await mkdir(recovery, { mode: 0o700 });
        for (const d of [primary, recovery]) await persistPrivateCopy(d, { metadata: meta, sealedParts, leaf });
        const key = await this.heldKey();
        try { await verifyPrivateCopies(meta, key, [primary, recovery]); } finally { key.fill(0); }
        await mkdir(this.unitDir(u), { recursive: true, mode: 0o700 });
        await writeExclusive(join(this.unitDir(u), "capture.json"), JSON.stringify({ metadata: meta, samples: out.samples }));
        const index = this.plan.units.findIndex(x => x.generation.jobRunId === u.generation.jobRunId);
        const restored = await privateRestore(this.host, this.plan, config, u.originalProofSha256, [primary, recovery],
          `nsb_restore_${this.plan.purpose}_${String(index).padStart(2, "0")}`, signal);
        await writeExclusive(join(this.unitDir(u), "restore.json"), JSON.stringify(restored));
        return this.receipt(stage, units, { remoteSequence: rec.sequence, parts: meta.parts.length, coverageRootSha256: meta.coverageRootSha256,
          leafSha256: meta.leafSha256, privateCopies: 2, restoreTableHashes: restored.tableHashes, plaintextRestoreDropped: restored.plaintextRestoreDropped },
          true, restored.frozenProofParity === true && restored.plaintextRestoreDropped === true && (await this.copiesMatch(u)).ok);
      }
      case "publish": {
        const staged: { sha256: string; bytes: number }[] = [], leaves: { sha256: string; base64: string }[] = [];
        for (const x of units) {
          const capture = await this.local(`units/${x.generation.jobRunId}/capture.json`), meta = capture.metadata as CaptureMetadata;
          const [primary, recovery] = this.copyDirs(x);
          for (const part of meta.parts) {
            const a = await readExact(join(primary, `${part.ciphertextSha256}.bin`), 2 * MiB + 128), b = await readExact(join(recovery, `${part.ciphertextSha256}.bin`), 2 * MiB + 128);
            need(a.equals(b) && sha256(a) === part.ciphertextSha256, "ROOT_OR_CIPHER_COPY_MISMATCH");
            await this.send("app", "stage-cipher", stage, { object: { sha256: part.ciphertextSha256, bytes: part.ciphertextBytes }, cipherBase64: a.toString("base64"), unitJobRunIds: ids }, 75_000, signal);
            staged.push({ sha256: part.ciphertextSha256, bytes: part.ciphertextBytes });
          }
          const leaf = await readExact(join(primary, `leaf-${meta.leafSha256}.json`), NATIVE_HISTORICAL_ROUTING_BOUNDS.leafBytes);
          leaves.push({ sha256: meta.leafSha256, base64: leaf.toString("base64") });
        }
        const pub = (await this.send("app", "publish-root", stage, { newLeaves: leaves, unitJobRunIds: ids }, 170_000, signal)).result;
        const expect = await this.expected();
        await writeExclusive(join(this.batchDir(), "publication.json"), JSON.stringify({ previousRoot: expect.activeRoot, newRoot: pub.newRoot,
          retainedPriorRecords: pub.retainedPriorRecords, newRecords: pub.newRecords, stagedObjects: staged }));
        const st = await this.send("app", "status", "status", { verifyRoots: [pub.newRoot], verifyObjects: staged }, 30_000, signal);
        const present = st.checks.length === staged.length + 1 && st.checks.every((c: { present: boolean }) => c.present);
        return this.receipt(stage, units, { newRoot: pub.newRoot, retainedPriorRecords: pub.retainedPriorRecords, stagedObjects: staged.length },
          true, present && await this.allCopies(units));
      }
      case "activate": {
        const pub = await this.local("publication.json"); need(pub, "PUBLICATION_REQUIRED");
        const rec = await this.send("app", "activate-root", stage, { newRoot: pub.newRoot, unitJobRunIds: ids }, 620_000, signal);
        await writeExclusive(join(this.batchDir(), "activation.json"), JSON.stringify({ ...rec.result, finishedAt: rec.finishedAt }));
        this.expect = null; const expect = await this.expected();
        const st = await this.send("app", "status", "status", {}, 30_000, signal);
        const serving = this.rolesMatch(st, expect) && same(st.route, ["true", `${ARCHIVE_MOUNT}/${pub.newRoot.name}`, pub.newRoot.sha256]);
        return this.receipt(stage, units, { newRoot: pub.newRoot, newWebBaseline: rec.result.newWebBaseline, healthz: rec.result.healthz,
          workerUnchanged: rec.result.workerUnchanged, newWebOwnObservationRequired: true }, serving, serving && await this.allCopies(units));
      }
      case "retire": {
        const config = await this.frozenConfig(u);
        const rec = await this.db(stage, { op: "retire", config, proofSha256: u.originalProofSha256, unitLockKey: unitLockKey(u.generation.jobRunId) }, 100_000, signal);
        return this.receipt(stage, units, { remoteSequence: rec.sequence, committed: rec.commitAcknowledged === true }, rec.commitAcknowledged === true && rec.result?.committed === true,
          await this.allCopies(units));
      }
      case "independent-readback": {
        const config = await this.frozenConfig(u);
        const back = (await this.db(stage, { op: "readback", config, proofSha256: u.originalProofSha256 }, 80_000, signal)).result;
        return this.receipt(stage, units, { exactUnitAbsent: back.exactUnitAbsent, retainedRootsFullBytesMatch: back.retainedRootsFullBytesMatch },
          back.exactUnitAbsent === true, back.retainedRootsFullBytesMatch === true && await this.allCopies(units));
      }
      case "vacuum-main": {
        const v = (await this.db(stage, { op: "vacuum", component: "main", jobRunIds: units.map(x => x.generation.jobRunId) }, 100_000, signal)).result;
        return this.receipt(stage, units, { component: "main", acknowledged: v.acknowledged, elapsedMs: v.elapsedMs }, v.acknowledged === true, await this.allCopies(units));
      }
      case "toast-observation": {
        // READ ONLY metadata of the two target TOAST relations; no VACUUM is dispatched.
        const o = (await this.db(stage, { op: "toast-observation" }, 45_000, signal, { unitJobRunIds: ids })).result;
        return this.receipt(stage, units, toastObservationEvidence(o), toastObservationAcknowledged(o), await this.allCopies(units));
      }
      // History-only v1 stage name: a v2 plan never schedules it and this operator never runs it.
      case "vacuum-toast": throw new BatchRefusal("VACUUM_TOAST_STAGE_RETIRED");
      case "space-readback": {
        const s = (await this.db(stage, { op: "space" }, 60_000, signal, { unitJobRunIds: ids })).result;
        // Measured outcome kept SEPARATELY; reclaimedBytes stays 0 (no shrink/reuse/growth claim).
        await writeExclusive(join(this.batchDir(), `measured-outcome-${Date.now()}.json`), JSON.stringify({ contract: "native-storage-measured-outcome.v1",
          observedAt: new Date().toISOString(), relations: s.relations, reclaimedBytesClaimed: 0, osReturnedBytesClaimed: 0 }));
        return this.receipt(stage, units, { relations: s.relations, reclaimedBytes: 0 }, true, await this.allCopies(units));
      }
    }
  }

  /** Resume only: every ACK verified read-only against ACTUAL artifacts.
   * (1) the ACKs are exactly the schedule prefix; (2) exactly one local stage
   * evidence file per ACK, in order, whose CONTENT names this purpose, stage,
   * units, final plan, source, review and revisions; (3) the remote entries each
   * ACK consumed are exactly the stage's required set, matched entry-by-entry
   * (host, sequence, op, units, object, request and result digests, final plan,
   * source) against the hosts' read-only listing, never shared between ACKs; any
   * other remote entry must be this plan's read-only evidence or the declared
   * selection prelude; (4) the artifacts themselves: both private copies
   * (decrypted), restore parity, published root/objects on the host, the web
   * serving our root with our own baseline and an unchanged worker, and an
   * independent read-only absence + retained-root readback. Nothing acknowledged
   * is executed again. */
  async verifyAcknowledged(plan: NativeStorageBatchPlan, receipts: NativeStorageStageReceipt[], signal: AbortSignal): Promise<boolean> {
    const planSha256 = this.execution();
    need(nativeStoragePlanDigest(plan) === planSha256, "RESUME_SAME_MANIFEST_BOUND_PLAN");
    const schedule = nativeStorageBatchSchedule(this.plan);
    need(Array.isArray(receipts) && receipts.length < schedule.length && receipts.every((a, i) => a?.purpose === this.plan.purpose &&
      a.stage === schedule[i]!.stage && same(a.jobRunIds, schedule[i]!.units.map(x => x.generation.jobRunId)) && a.actualExitCode === 0 &&
      a.actionAcknowledged === true && a.independentFullOriginalBytesMatch === true && a.providerAuthority === false && a.reclaimedBytes === 0),
    "ACK_PREFIX_NOT_EXACT_SCHEDULE");
    const stagesDir = join(this.batchDir(), "stages");
    const files = (await readdir(stagesDir).catch(() => [] as string[])).sort();
    need(files.length === receipts.length, "ACK_LOCAL_EVIDENCE_SET");
    const evidence: Record<string, any>[] = [];
    for (const [i, ack] of receipts.entries()) {
      need(files[i] === `${pad(i + 1)}-${ack.stage}.json`, "ACK_LOCAL_EVIDENCE_SET");
      const bytes = await readExact(join(stagesDir, files[i]!), 16 * MiB);
      need(sha256(bytes) === ack.evidenceSha256, "ACK_LOCAL_EVIDENCE_DIGEST");
      const ev = JSON.parse(bytes.toString("utf8"));
      need(ev.contract === "finite-native-storage-stage-evidence.v2" && ev.purpose === this.plan.purpose && ev.stage === ack.stage &&
        ev.stageSequence === i + 1 && same(ev.jobRunIds, ack.jobRunIds) && ev.planSha256 === planSha256 &&
        ev.sourceManifestSha256 === this.plan.sourceManifestSha256 && ev.actualSourceReviewSha256 === this.plan.actualSourceReviewSha256 &&
        ev.operatorRevision === this.host.operatorRevision && ev.runtimeRevision === this.host.runtimeRevision &&
        Array.isArray(ev.remote) && REQUIRED_REMOTE[ack.stage](ev.remote), "ACK_LOCAL_EVIDENCE_IDENTITY");
      evidence.push(ev);
    }
    this.stageSequence = files.length;
    this.sequences = { app: null, db: null };
    await this.syncRemote(signal);
    const selection = await loadSelection(this.host.stateRoot, this.plan, this.host.runtimeRevision).catch(() => null);
    this.verifyRemoteSet(planSha256, receipts, evidence, selection?.sha256 ?? null);
    const verified: Record<string, unknown>[] = [];
    for (const [i, ack] of receipts.entries()) {
      const ev = evidence[i]!, units = this.plan.units.filter(x => ack.jobRunIds.includes(x.generation.jobRunId));
      if (ack.stage === "capture-restore") {
        const key = await this.heldKey();
        try { for (const x of units) {
          const capture = await this.local(`units/${x.generation.jobRunId}/capture.json`), restore = await this.local(`units/${x.generation.jobRunId}/restore.json`);
          need(capture?.metadata?.proofSha256 === x.originalProofSha256 && capture.metadata.leafSha256 === ev.leafSha256 &&
            capture.metadata.coverageRootSha256 === ev.coverageRootSha256, "ACK_CAPTURE_EVIDENCE_BINDING");
          await verifyPrivateCopies(capture.metadata, key, this.copyDirs(x));
          need(restore?.frozenProofParity === true && restore?.plaintextRestoreDropped === true && same(restore.tableHashes, ev.restoreTableHashes), "ACK_RESTORE_NOT_VERIFIED");
        } } finally { key.fill(0); }
      } else if (ack.stage === "publish") {
        const pub = await this.local("publication.json"), refs = ev.remote as RemoteRef[];
        need(pub && same(pub.newRoot, ev.newRoot) && pub.stagedObjects.length === ev.stagedObjects &&
          same(refs.slice(0, -1).map(r => r.subjectSha256s), pub.stagedObjects.map((o: { sha256: string }) => [o.sha256])), "ACK_PUBLICATION_EVIDENCE_BINDING");
        const st = await this.send("app", "status", "status", { verifyRoots: [pub.newRoot], verifyObjects: pub.stagedObjects }, 30_000, signal);
        need(st.checks.every((c: { present: boolean }) => c.present), "ACK_PUBLISHED_ROOT_OR_OBJECT_MISSING");
      } else if (ack.stage === "activate") {
        const activation = await this.local("activation.json");
        need(activation?.activeRoot?.sha256 === ev.newRoot?.sha256 && activation.activeRoot.name === ev.newRoot.name &&
          same(activation.newWebBaseline, ev.newWebBaseline), "ACK_ACTIVATION_EVIDENCE_BINDING");
        this.expect = null; const expect = await this.expected(), st = await this.send("app", "status", "status", {}, 30_000, signal);
        need(this.rolesMatch(st, expect) && same(st.route, ["true", `${ARCHIVE_MOUNT}/${expect.activeRoot.name}`, expect.activeRoot.sha256]), "ACTIVE_ROOT_OR_ROLE_CHANGED_SINCE_ACK");
      } else if (ack.stage === "retire" || ack.stage === "independent-readback") {
        need(ack.stage === "independent-readback" || ev.committed === true, "ACK_RETIREMENT_NOT_OBSERVED");
        for (const x of units) {
          const back = (await this.db("evidence", { op: "readback", config: await this.frozenConfig(x), proofSha256: x.originalProofSha256 }, 80_000, signal)).result;
          need(back.exactUnitAbsent === true && back.retainedRootsFullBytesMatch === true, "ACK_RETIREMENT_NOT_OBSERVED");
        }
      }
      verified.push({ stage: ack.stage, jobRunIds: ack.jobRunIds, evidenceSha256: ack.evidenceSha256, remote: ev.remote.map((r: RemoteRef) => `${r.host}:${r.sequence}`) });
    }
    await writeExclusive(join(this.batchDir(), `resume-verification-${Date.now()}.json`), JSON.stringify({ planSha256, verified }));
    return true;
  }

  /** Exact remote accounting over BOTH hosts' durable listings (see verifyAcknowledged). */
  private verifyRemoteSet(planSha256: string, receipts: NativeStorageStageReceipt[], evidence: Record<string, any>[], selectionSha256: string | null) {
    const listed = new Map<string, any>();
    for (const host of ["app", "db"] as const) for (const e of this.remoteListing[host]) listed.set(`${host}:${e.sequence}`, { ...e, host });
    const ownSource = (id: any) => id?.purpose === this.plan.purpose && id.sourceManifestSha256 === this.plan.sourceManifestSha256 &&
      id.actualSourceReviewSha256 === this.plan.actualSourceReviewSha256 && id.operatorRevision === this.host.operatorRevision &&
      id.runtimeRevision === this.host.runtimeRevision;
    const claimed = new Set<string>(), last: Record<ActorHost, number> = { app: 0, db: 0 };
    for (const [i, ack] of receipts.entries()) {
      for (const ref of evidence[i]!.remote as RemoteRef[]) {
        const key = `${ref.host}:${ref.sequence}`, e = listed.get(key), id = e?.identity;
        need(e && !claimed.has(key) && ref.sequence > last[ref.host], "ACK_REMOTE_RECEIPT_SET");
        claimed.add(key); last[ref.host] = ref.sequence;
        need(ownSource(id) && id.phase === "execution" && id.planSha256 === planSha256 && !id.selectionSha256 && id.sequence === ref.sequence &&
          e.stage === ack.stage && id.stage === ack.stage && ref.stage === ack.stage && e.op === ref.op && id.op === ref.op && (id.stageOp ?? null) === ref.stageOp &&
          same(ref.unitJobRunIds, ack.jobRunIds) && same(id.unitJobRunIds, ref.unitJobRunIds) && same(id.subjectSha256s, ref.subjectSha256s) &&
          id.requestSha256 === ref.requestSha256 && e.receipt?.actualExitCode === 0 && e.receipt.statusReadOnlyRequired === false &&
          e.receipt.resultSha256 === ref.resultSha256, "ACK_REMOTE_IDENTITY");
      }
    }
    const firstExecution = Math.min(...this.remoteListing.app.filter(e => e.identity?.phase === "execution").map(e => e.sequence as number), Infinity);
    for (const [key, e] of listed) {
      const id = e.identity;
      need(ownSource(id), "FOREIGN_REMOTE_ENTRY");
      if (claimed.has(key)) continue;
      if (id.phase === "selection-prelude") {
        need(e.host === "app" && e.sequence < firstExecution && e.stage === "plan" && e.op === "db" && ["select", "freeze"].includes(id.stageOp) &&
          selectionSha256 !== null && id.selectionSha256 === selectionSha256 && !id.planSha256, "FOREIGN_OR_LATE_SELECTION_PRELUDE");
        continue;
      }
      need(id.phase === "execution" && id.planSha256 === planSha256 && e.stage === "evidence" &&
        (e.op === "db" ? e.host === "app" && EVIDENCE_STAGE_OPS.includes(id.stageOp) : e.op === "sample-capacity" && e.host === "db"),
      "UNKNOWN_EXTRA_REMOTE_STAGE_TRANSITION");
    }
  }
}

/** Operator-private independent restore: a NEW database from the full-DDL
 * template of the owned private cluster, both private copies decrypted, 8-table
 * parity with the frozen proof, plaintext database dropped right after. */
export async function privateRestore(host: ProductionHostConfig, plan: NativeStorageBatchPlan, config: UnitConfig, proofSha256: string,
  copyDirectories: [string, string], restoreDatabase: string, signal?: AbortSignal) {
  const { spawn: spawnChild } = await import("node:child_process");
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: host.stateRoot,
    TSX_TSCONFIG_PATH: join(REPO_ROOT, "tsconfig.json"), NSB_HOST_MODE: "owned", NSB_STATE_ROOT: host.stateRoot, APP_BUILD_ID: plan.targetRevision,
    DB_SSL_MODE: "disable", DATABASE_URL: databaseUrl(host.privateRestore.role, host.privateRestore.socketDirectory, host.privateRestore.port, "postgres") };
  const request = { op: "restore", targetRevision: plan.targetRevision, config, proofSha256, keyFile: host.heldKey.primaryPath,
    copyDirectories, restoreDatabase, templateDatabase: host.privateRestore.template, dropAfterParity: true };
  return new Promise<any>((resolve, reject) => {
    const child = spawnChild(process.execPath, ["--import", TSX_LOADER, STAGE_ENTRY_FILE], { cwd: host.stateRoot, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", done = false;
    const finish = (e: Error | null, v?: unknown) => { if (done) return; done = true; clearTimeout(timer); if (e) reject(e); else resolve(v); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new BatchRefusal("PRIVATE_RESTORE_DEADLINE")); }, 150_000);
    signal?.addEventListener("abort", () => { child.kill("SIGKILL"); finish(new BatchRefusal("PRIVATE_RESTORE_ABORTED")); }, { once: true });
    child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); const i = out.indexOf("\n"); if (i === -1) return;
      const line = JSON.parse(out.slice(0, i)); finish(line.type === "result" ? null : new BatchRefusal(line.code ?? "PRIVATE_RESTORE_REFUSED"), line.value); });
    child.stderr.on("data", () => undefined);
    child.on("close", code => finish(new BatchRefusal(`PRIVATE_RESTORE_EXIT_WITHOUT_RESULT:${code}`)));
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
