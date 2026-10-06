import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { NATIVE_STORAGE_BATCH_CONTRACT, NATIVE_STORAGE_BATCH_LIMITS, nativeStoragePlanDigest, runFiniteNativeStorageBatch,
  validateNativeStorageBatchPlan, type NativeStorageBatchPlan, type NativeStorageBatchUnit } from "../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import { canonicalSha, need, readExact, safeError, sha256, writeExclusive } from "./common";
import { computeSourcePack, REPO_ROOT, verifySourceReview } from "./source-pack";
import { FileBatchJournal } from "./journal";
import { abandonOwnedPurpose, acquireOwner, disposePreDispatchRefused, disposeUnacknowledgedMaintenance, ownershipStatus, parseCursor, recordExamined,
  releaseOwner, requireOwner, settledPrefix, vetoPermanence, type Cursor, type Disposition } from "./operator-ownership";
import { collectMaintenanceSettlement, SETTLEMENT_APPLICATION } from "./maintenance-settlement";
import { Client } from "pg";
import { ACTOR_FILE, BOOTSTRAP_SOURCE, loadPrestate, loadProductionHost, loadSelection, ProductionHostBatchBackend, ProductionSshTransport,
  type ActorTransport, type ProductionHostConfig, type ProductionPrestate, type SelectionPrelude } from "./production-transport";
import { unitLockKey } from "./backend";
import type { UnitConfig } from "./capture";

/** Production commands. Every command that reaches a host takes an explicit
 * transport: the CLI passes the SSH transport armed for ONE purpose; the
 * fixture harness passes its local fixed-actor transport. */
const purposeOf = (value: string | undefined) => { need(value && /^[a-f0-9]{12}$/.test(value), "EXACT_PURPOSE"); return value; };
const batchDir = (host: ProductionHostConfig, purpose: string) => join(host.stateRoot, "batches", purpose);
async function loadPlan(host: ProductionHostConfig, purpose: string) {
  const value = JSON.parse((await readExact(join(batchDir(host, purpose), "plan.json"), 1024 * 1024)).toString("utf8")) as NativeStorageBatchPlan;
  validateNativeStorageBatchPlan(value);
  need(value.purpose === purpose && value.targetRevision === host.operatorRevision, "EXACT_PLAN_AND_OPERATOR_REVISION");
  return value;
}

/** Read-only fresh prestate: per-role identity, configs, compose model, archive
 * env digest, active root and the reviewed runtime source set. The root
 * operator reviews this file and pins its digest in the host config. */
export async function productionPrestate(hostPath: string, purpose: string, runtimeManifestPath: string, transport: ActorTransport) {
  const host = await loadProductionHost(hostPath);
  const base = { purpose, targetRevision: host.operatorRevision, sourceManifestSha256: "0".repeat(64), actualSourceReviewSha256: "0".repeat(64),
    expectedDatabaseBudgetBytes: host.databaseBudgetBytes, units: [] } as unknown as NativeStorageBatchPlan;
  const backend = new ProductionHostBatchBackend(host, base, "", transport);
  const st = await backend.status();
  const runtime = JSON.parse((await readExact(runtimeManifestPath, 1024 * 1024)).toString("utf8"));
  const m = /^\/run\/adsecute-native-archive\/(routing-[a-z0-9-]{1,80})$/.exec(st.route[1] ?? "");
  need(st.route[0] === "true" && m && /^[a-f0-9]{64}$/.test(st.route[2] ?? ""), "ROUTED_READER_REQUIRED");
  const pick = (r: Record<string, string>) => ({ containerId: r.containerId, imageId: r.imageId, repoDigest: r.repoDigest, startedAt: r.startedAt,
    otherEnvSha256: r.otherEnvSha256, mountsSha256: r.mountsSha256 });
  const prestate: ProductionPrestate = { contract: "native-storage-production-prestate.v1", observedAt: st.observedAt, runtimeRevision: host.runtimeRevision,
    roles: { web: pick(st.roles.web), worker: pick(st.roles.worker) }, composeModelSha256: st.composeModelSha256,
    globalConfigHashes: st.globalConfigHashes, archiveEnvSha256: st.archiveEnvSha256, activeRoot: { sha256: st.route[2], name: m[1]! },
    runtimeSourceHashes: runtime.files ?? runtime, compose: st.compose };
  for (const role of ["web", "worker"] as const) {
    need(st.roles[role].health === "healthy" && st.roles[role].buildId === host.runtimeRevision && st.roles[role].labelRevision === host.runtimeRevision,
      `RUNTIME_ROLE_NOT_AT_RUNTIME_REVISION:${role}`);
    // The (runtime-pinned) compose model must BE the running release: image id, digest and predicted env.
    need(st.compose?.pins?.APP_IMAGE_TAG === host.runtimeRevision && st.compose.pins.APP_BUILD_ID === host.runtimeRevision &&
      st.compose.roles?.[role]?.matches === true && st.compose.roles[role].resolvedImageId === st.roles[role].imageId,
    `COMPOSE_MODEL_NOT_RUNNING_RELEASE:${role}`);
  }
  const raw = JSON.stringify(prestate, null, 2);
  const file = join(host.stateRoot, `prestate-${Date.now()}.json`);
  await writeExclusive(file, raw, 0o400);
  return { command: "production-prestate", file, sha256: sha256(raw), distinctRoleImages: prestate.roles.web.imageId !== prestate.roles.worker.imageId,
    compose: prestate.compose };
}

/** Metadata-only selection and read-only whole-original freeze through the actor.
 * This prelude is its own phase: it binds ONLY its declared, write-once selection
 * (selection.json) digest. The finalized plan (selected units) has a different
 * digest that every execution stage and ACK must match; one is never used as the other. */
export async function productionPlan(o: Record<string, string>, transport: ActorTransport) {
  const host = await loadProductionHost(o.host!), purpose = purposeOf(o.purpose);
  const pack = await computeSourcePack(host.operatorRevision, REPO_ROOT, host.runtimeRevision);
  need(o.review, "REVIEW_REQUIRED");
  const reviewSha = sha256(await readFile(o.review!));
  await verifySourceReview(o.review!, { sourceManifestSha256: pack.sourceManifestSha256, actualSourceReviewSha256: reviewSha,
    mode: transport.kind === "fixture" ? "owned" : "production" });
  const base: NativeStorageBatchPlan = { contract: NATIVE_STORAGE_BATCH_CONTRACT, purpose, targetRevision: host.operatorRevision,
    sourceManifestSha256: pack.sourceManifestSha256, actualSourceReviewSha256: reviewSha, expectedDatabaseBudgetBytes: host.databaseBudgetBytes,
    cutoffObservedAt: o.cutoff!, units: [] };
  const cursor = parseCursor(o.cursor), revisit = o.revisit === "true";
  need(o.revisit === undefined || o.revisit === "true", "EXACT_REVISIT_FLAG");
  const limit = Number(o.limit ?? 32), maxUnits = Number(o["max-units"] ?? NATIVE_STORAGE_BATCH_LIMITS.generations);
  need(Number.isInteger(maxUnits) && maxUnits >= 1 && maxUnits <= NATIVE_STORAGE_BATCH_LIMITS.generations, "FINITE_GENERATION_COUNT");
  // The selection's own bounds, checked before the lease so a malformed request never strands an owner.
  need(Number.isInteger(limit) && limit >= 1 && limit <= 64, "FINITE_SELECTION_LIMIT");
  need(Number.isFinite(Date.parse(o.cutoff ?? "")), "EXACT_CUTOFF");
  // D149: ONE owner per private operator state root, taken before anything is written; the cursor must continue the
  // recorded chain exactly (behind = rescan only as an explicit revisit; ahead = refused silent skip).
  await acquireOwner(host.stateRoot, purpose, { cursor, revisit });
  const declaration: SelectionPrelude = { contract: "native-storage-selection-prelude.v1", purpose, operatorRevision: host.operatorRevision,
    runtimeRevision: host.runtimeRevision, sourceManifestSha256: pack.sourceManifestSha256, actualSourceReviewSha256: reviewSha,
    expectedDatabaseBudgetBytes: host.databaseBudgetBytes, cutoffObservedAt: o.cutoff!, cursor, limit, maxUnits };
  const dir = batchDir(host, purpose), unitsDir = join(dir, "units");
  await mkdir(unitsDir, { recursive: true, mode: 0o700 });
  // Write-once: a consumed prelude is never rewritten or re-declared for this purpose.
  const selectionSha256 = await writeExclusive(join(dir, "selection.json"), JSON.stringify(declaration), 0o400);
  const backend = new ProductionHostBatchBackend(host, base, o.review!, transport, { declaration, sha256: selectionSha256 });
  await loadPrestate(host);
  const routed = new Set<string>((await backend.status()).routedJobs);
  const selection = await backend.planOp({ op: "select", selection: { cursor, limit, cutoffObservedAt: o.cutoff } });
  const units: NativeStorageBatchUnit[] = [], vetoes: { jobRunId: string; code: string }[] = [];
  // Every candidate of the ordered window is either dispositioned (unit/veto, dated) or is the ONE that stopped the loop.
  const ordered: Cursor[] = selection.candidates.map((c: { generation: Cursor }) => ({ asOfDate: c.generation.asOfDate, jobRunId: c.generation.jobRunId }));
  const dispositions: Disposition[] = [];
  const veto = (at: Cursor, code: string) => { vetoes.push({ jobRunId: at.jobRunId, code }); dispositions.push({ candidate: at, outcome: "veto", code, permanence: vetoPermanence(code) }); };
  let total = 0, brokeAt: number | null = null;
  for (const [i, c] of selection.candidates.entries()) {
    const at = ordered[i]!;
    if (units.length >= maxUnits) { brokeAt = i; break; }
    if (c.metadataVeto) { veto(at, c.metadataVeto); continue; }
    if (routed.has(c.generation.jobRunId)) { veto(at, "ALREADY_ARCHIVED_ROUTE"); continue; }
    if (total + c.evaluations > NATIVE_STORAGE_BATCH_LIMITS.evaluations) { brokeAt = i; break; }
    try {
      const frozen = await backend.planOp({ op: "freeze", capture: { generation: c.generation, expectedEvaluations: c.evaluations,
        expectedContexts: c.contexts, sourceRevision: host.runtimeRevision, consumerInventorySha256: pack.sourceManifestSha256 } });
      const config = frozen.config as UnitConfig;
      need(canonicalSha(config) === frozen.proofSha256, "FROZEN_PROOF_SELF_CHECK");
      await writeExclusive(join(unitsDir, `${c.generation.jobRunId}.config.json`), JSON.stringify(config));
      units.push({ generation: config.generation, evaluations: config.evaluations, contexts: config.contexts, originalProofSha256: frozen.proofSha256 });
      dispositions.push({ candidate: at, outcome: "unit" });
      total += config.evaluations;
    } catch (e) { veto(at, safeError(e).code.replace(/^PRODUCTION_ACTOR_REFUSED:ACTUAL_TERMINAL_RESULT_REQUIRED:/, "")); }
  }
  const prefix = settledPrefix(cursor, ordered, dispositions, brokeAt);
  await recordExamined(host.stateRoot, purpose, { startCursor: cursor, revisit, selectionSha256, cutoffObservedAt: o.cutoff!, limit, maxUnits,
    windowSize: ordered.length, dispositions, ...prefix });
  const examined = { examinedThrough: prefix.examinedThrough, breakCandidate: prefix.breakCandidate, transientVetoes: prefix.transientVetoes };
  if (!units.length) {
    // Read-only terminal scan (empty or all-veto window): released now; only a non-empty settled prefix advances the chain.
    const release = await releaseOwner(host.stateRoot, purpose, "terminal-scan");
    return { command: "plan", purpose, actualExitCode: 1, reason: "NO_ELIGIBLE_ORIGINAL_IN_CURSOR_WINDOW", terminalScan: true, selectionSha256, units: [], vetoes,
      ...examined, chainAdvanced: release.advancesChain };
  }
  const value = { ...base, units };
  validateNativeStorageBatchPlan(value);
  await loadSelection(host.stateRoot, value, host.runtimeRevision);
  await writeExclusive(join(dir, "plan.json"), JSON.stringify(value));
  return { command: "plan", purpose, selectionSha256, planDigest: nativeStoragePlanDigest(value), units: units.map(u => ({ jobRunId: u.generation.jobRunId,
    evaluations: u.evaluations, contexts: u.contexts, originalProofSha256: u.originalProofSha256 })), vetoes, ...examined, evaluationRowsReadBySelection: 0 };
}

export async function productionExecute(o: Record<string, string>, transport: ActorTransport, resume = false) {
  const host = await loadProductionHost(o.host!), purpose = purposeOf(o.purpose), value = await loadPlan(host, purpose);
  need(o.review, "REVIEW_REQUIRED");
  await loadSelection(host.stateRoot, value, host.runtimeRevision);
  const consumed = await readFile(join(host.stateRoot, "purposes", `${purpose}.json`)).then(() => true, () => false);
  need(resume || !consumed, "PURPOSE_ALREADY_CONSUMED");
  // D149: only the current owner executes or resumes (same plan, original journal start); released purposes never run again.
  await requireOwner(host.stateRoot, purpose);
  await mkdir(join(host.stateRoot, "purposes"), { recursive: true, mode: 0o700 });
  const journal = new FileBatchJournal(join(batchDir(host, purpose), "journal"), join(host.stateRoot, "purposes"), resume ? "resume" : "fresh");
  const backend = new ProductionHostBatchBackend(host, value, o.review!, transport);
  const result = await runFiniteNativeStorageBatch(value, journal, backend);
  await writeExclusive(join(batchDir(host, purpose), `result-${resume ? "resume-" : ""}${Date.now()}.json`), JSON.stringify(result));
  if (result.actualExitCode === 0) await releaseOwner(host.stateRoot, purpose, "finished");
  return result;
}

/** D149 operator commands on the private operator state root. None reaches a host; none changes a journal. */
export async function abandonPurpose(o: Record<string, string>) {
  const host = await loadProductionHost(o.host!);
  return abandonOwnedPurpose(host.stateRoot, purposeOf(o.purpose));
}
/** Collects the live SELECT-only settlement proof over ONE explicitly declared read-only connection (no password
 * argument: libpq environment/.pgpass only), every transaction READ ONLY by session default as well. */
export async function disposeMaintenanceUnknown(o: Record<string, string>) {
  const host = await loadProductionHost(o.host!), purpose = purposeOf(o.purpose);
  const pgHost = o["pg-host"] ?? "", database = o["pg-database"] ?? "", user = o["pg-user"] ?? "", port = Number(o["pg-port"] ?? "");
  need((isAbsolute(pgHost) || ["127.0.0.1", "::1", "localhost"].includes(pgHost)) && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database) &&
    /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(user) && Number.isInteger(port) && port > 0 && port < 65536, "EXACT_READ_ONLY_SETTLEMENT_CONNECTION");
  const pack = await computeSourcePack(host.operatorRevision, REPO_ROOT, host.runtimeRevision);
  return disposeUnacknowledgedMaintenance(host.stateRoot, purpose, { expectedDatabase: database, operatorRevision: host.operatorRevision,
    runtimeRevision: host.runtimeRevision, sourceManifestSha256: pack.sourceManifestSha256 }, async (binding, configs) => {
    const db = new Client({ host: pgHost, port, user, database, application_name: SETTLEMENT_APPLICATION, connectionTimeoutMillis: 4000,
      query_timeout: 8500, options: "-c default_transaction_read_only=on" });
    db.on("error", () => undefined);
    await db.connect();
    try { return await collectMaintenanceSettlement(db, binding, configs); } finally { await db.end(); }
  });
}
export async function disposePreDispatch(o: Record<string, string>) {
  const host = await loadProductionHost(o.host!);
  return disposePreDispatchRefused(host.stateRoot, purposeOf(o.purpose));
}
export async function ownerStatus(o: Record<string, string>) {
  return ownershipStatus((await loadProductionHost(o.host!)).stateRoot);
}

/** Builds (never sends) the exact payload for review; no transport exists here. */
export async function prepareProduction(o: Record<string, string>) {
  const host = await loadProductionHost(o.host!), purpose = purposeOf(o.purpose), value = await loadPlan(host, purpose);
  need(/^[a-z-]{3,40}$/.test(o.stage ?? "") && /^(db|stage-cipher|publish-root|activate-root)$/.test(o.op ?? "") &&
    /^(evidence|pins|readback|space|toast-observation|vacuum|capture|retire|)$/.test(o["stage-op"] ?? ""), "STAGE_AND_OP_REQUIRED");
  // An UNARMED SSH transport refuses any send; payload() never sends.
  const backend = new ProductionHostBatchBackend(host, value, "", new ProductionSshTransport(null));
  const unit = value.units.find(u => u.generation.jobRunId === o.unit);
  const config = unit ? JSON.parse((await readExact(join(batchDir(host, purpose), "units", `${unit.generation.jobRunId}.config.json`), 4 * 1024 * 1024)).toString("utf8")) : null;
  const so = o["stage-op"];
  const request = so === "evidence" ? { op: so, databaseBudgetBytes: host.databaseBudgetBytes, expectedRole: host.role, knownApplicationNames: host.knownApplicationNames,
    jobRunIds: value.units.map(u => u.generation.jobRunId) } : so === "space" || so === "toast-observation" ? { op: so } : so === "vacuum" ? { op: so, component: "main", jobRunIds: value.units.map(u => u.generation.jobRunId) }
    : unit && config ? { op: so, config, proofSha256: unit.originalProofSha256, ...(so === "retire" ? { unitLockKey: unitLockKey(unit.generation.jobRunId) } : {}) } : null;
  const all = value.units.map(u => u.generation.jobRunId);
  const payload = await backend.payload("app", o.op!, o.stage as never, o.op === "db" ? { request, ...(so === "space" || so === "toast-observation" ? { unitJobRunIds: all } : {}) } : { unitJobRunIds: all });
  const raw = JSON.stringify(payload), out = join(batchDir(host, purpose), "prepared-payloads");
  await mkdir(out, { recursive: true, mode: 0o700 });
  const name = `${o.stage}-${o.op}-${so || "na"}-${Date.now()}`;
  const payloadSha256 = await writeExclusive(join(out, `${name}.payload.json`), raw, 0o400);
  return { command: "prepare-production", sent: false, sshInvoked: false, purpose, payloadSha256, payloadBytes: Buffer.byteLength(raw),
    stageBundleSha256: payload.stageBundleSha256 ?? null, bootstrapSha256: sha256(BOOTSTRAP_SOURCE), actorSha256: sha256(await readFile(ACTOR_FILE)),
    operatorRevision: payload.operatorRevision, runtimeRevision: payload.runtimeRevision };
}
