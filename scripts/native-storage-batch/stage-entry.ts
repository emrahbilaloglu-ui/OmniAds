import { statfs } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { BatchRefusal, need, readExact, safeError, sha256, UUID } from "./common";
import { collectWholeOriginal, readCaptureMetadata, sealAndPersist, sealWholeOriginal, verifyCopies, verifyPrivateCopies,
  type UnitConfig } from "./capture";
import { restoreIntoOwnedNewDatabase } from "./restore";
import { acceptPrepared, prepareUnitRetirement, unitScope } from "./retire";
import { databaseAdmissionFacts, independentReadback, readSelectedPinClosure, selectClosedDayCandidates, spaceReadback, vacuumComponent } from "./maintenance";

/** ONE finite stage per process. Reads one JSON request line on stdin, writes
 * JSON lines on stdout; every library log goes to stderr. Closed operation set;
 * no SQL/command/path is accepted beyond fixed typed fields. The only DB is
 * DATABASE_URL. Owned mode refuses any non-owned socket/database. */
for (const method of ["log", "info", "warn", "debug"] as const)
  console[method] = (...args: unknown[]) => { process.stderr.write(`${args.map(a => typeof a === "string" ? a : "[object]").join(" ")}\n`); };
const emit = (value: unknown) => new Promise<void>(done => process.stdout.write(`${JSON.stringify(value)}\n`, () => done()));
const lines: string[] = []; let waiter: ((line: string) => void) | null = null, buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffered += chunk; if (buffered.length > 4 * 1024 * 1024) { process.exitCode = 1; process.exit(1); }
  let index; while ((index = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
    if (waiter) { const w = waiter; waiter = null; w(line); } else lines.push(line);
  }
});
const readLine = () => new Promise<string>((resolveLine, reject) => {
  if (lines.length) return resolveLine(lines.shift()!);
  waiter = resolveLine; process.stdin.once("end", () => reject(new BatchRefusal("PROTOCOL_EOF")));
});

const MODE = process.env.NSB_HOST_MODE, STATE = process.env.NSB_STATE_ROOT ?? "";
function ownedScope(url: string, allowAdmin = false) {
  const parsed = new URL(url), host = parsed.searchParams.get("host") ?? "", db = parsed.pathname.slice(1);
  need(parsed.hostname === "localhost" && STATE.startsWith("/") && host.startsWith(`${STATE}/`) && !host.includes(".."),
    "OWNED_SOCKET_SCOPE_REQUIRED");
  need(/^nsb_(source|restore)_[a-f0-9]{12}(_[0-9]{2})?$/.test(db) || allowAdmin && db === "postgres", "OWNED_DATABASE_NAME_REQUIRED");
  need(![5432, 15432].includes(Number(parsed.searchParams.get("port") ?? "5432")), "OWNED_PORT_REQUIRED");
}
async function client(url: string, op: string, queryTimeout: number) {
  const db = new Client({ connectionString: url, connectionTimeoutMillis: 4000, query_timeout: queryTimeout,
    application_name: `nsb-${op}`.slice(0, 63) });
  db.on("error", () => undefined);
  await db.connect(); return db;
}

async function main() {
  need(MODE === "owned" || MODE === "production", "EXPLICIT_HOST_MODE");
  const request = JSON.parse(await readLine());
  need(request && typeof request.op === "string" && /^[a-f0-9]{40}$/.test(request.targetRevision ?? ""), "EXACT_STAGE_REQUEST");
  // Operator source revision (targetRevision) and live runtime revision are separate explicit fields.
  const runtimeRevision = MODE === "production" ? request.runtimeRevision : request.runtimeRevision ?? request.targetRevision;
  need(typeof runtimeRevision === "string" && /^[a-f0-9]{40}$/.test(runtimeRevision) && process.env.APP_BUILD_ID === runtimeRevision, "EXACT_IMAGE_REVISION");
  const url = process.env.DATABASE_URL ?? "";
  const dbOps = ["healthcheck-sample", "evidence", "select", "freeze", "capture", "pins", "restore", "retire", "readback", "vacuum", "space"];
  need(dbOps.includes(request.op) || ["fresh-read", "web-serve", "publish-routing"].includes(request.op), "CLOSED_OPERATION_SET");
  if (dbOps.includes(request.op) && MODE === "owned") ownedScope(url, request.op === "restore");
  need(MODE === "owned" || !["healthcheck-sample", "restore"].includes(request.op), "OWNED_ONLY_OPERATION");
  const key = async () => {
    const bytes = await readExact(String(request.keyFile), 32); need(bytes.length === 32, "SEPARATE_ENCRYPTION_KEY_REQUIRED"); return bytes;
  };
  const config = (): UnitConfig => { unitScope(request.config, request.proofSha256); return request.config; };
  switch (request.op) {
    case "fresh-read": {
      // A NEW web process: the reader configuration comes only from its env.
      const { readNativeHistoricalAdEvidence } = await import("../../lib/creative-decision-engine/native-historical-archive-reader");
      const { readPackagedNativeHistoricalWorker } = await import("../../lib/creative-decision-engine/native-historical-archive-worker-client");
      const { computeSourcePack } = await import("./source-pack");
      need(Array.isArray(request.requests) && request.requests.length >= 1 && request.requests.length <= 64, "FINITE_READ_SET");
      if (MODE === "owned") process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX = (await key()).toString("hex");
      const reads = [];
      for (const r of request.requests) {
        const result = await readNativeHistoricalAdEvidence(r);
        reads.push({ evaluationId: r.evaluationId, status: result.status,
          evaluationSha256: result.status === "historical_available" ? sha256(result.rowJson.evaluation) : null,
          providerAuthority: result.status === "historical_available" ? result.providerAuthority : null });
      }
      const pack = await computeSourcePack(request.targetRevision);
      return emit({ type: "result", value: { reads, sourceManifestSha256: pack.sourceManifestSha256,
        workerSha256: (await readPackagedNativeHistoricalWorker()).sha256,
        routingRootSha256: process.env.ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256 } });
    }
    case "web-serve": {
      // OWNED real-HTTP fixture of the evidence route's historical branch: the
      // production reader + the route's exact status/headers/JSON serialization,
      // on 127.0.0.1 for one bounded probe. No auth/flags layer (owned only);
      // NOT a live route or Chrome proof.
      need(MODE === "owned", "OWNED_ONLY_OPERATION");
      const { createServer } = await import("node:http");
      const { readNativeHistoricalAdEvidence } = await import("../../lib/creative-decision-engine/native-historical-archive-reader");
      const { readPackagedNativeHistoricalWorker } = await import("../../lib/creative-decision-engine/native-historical-archive-worker-client");
      const { computeSourcePack } = await import("./source-pack");
      process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX = (await key()).toString("hex");
      let served = 0;
      const server = createServer((req, res) => { void (async () => {
        const url = new URL(req.url ?? "/", "http://owned.invalid"), p = (k: string) => url.searchParams.get(k) ?? "";
        if (req.method !== "GET" || url.pathname !== "/api/creatives/decision-engine-v3/evidence" || p("view") !== "historical" || served >= 64) {
          res.writeHead(404, { "content-type": "application/json" }).end("{}"); return; }
        const result = await readNativeHistoricalAdEvidence({ generation: { businessId: p("businessId"), jobRunId: p("archiveJobRunId"),
          asOfDate: p("asOf"), engineVersion: p("engineVersion") }, providerAccountId: p("providerAccountId"), adId: p("adId"), evaluationId: p("evaluationId") });
        const body = JSON.stringify(result); served++;
        res.writeHead(result.status === "limited" ? 429 : result.status === "unavailable" ? 409 : 200, { "content-type": "application/json",
          "cache-control": "private, no-store", "content-length": String(Buffer.byteLength(body)) }).end(body);
      })().catch(() => { res.writeHead(500).end(); }); });
      await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
      const address = server.address(); need(address && typeof address === "object", "WEB_LISTEN");
      const stop = readLine();
      await emit({ type: "listening", port: address.port, sourceManifestSha256: (await computeSourcePack(request.targetRevision)).sourceManifestSha256,
        workerSha256: (await readPackagedNativeHistoricalWorker()).sha256, routingRootSha256: process.env.ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256 });
      need(JSON.parse(await stop)?.action === "stop", "WEB_STOP_PROTOCOL");
      await new Promise<void>(done => server.close(() => done()));
      return emit({ type: "result", value: { served } });
    }
    case "publish-routing": {
      // Immutable complete-root publisher. Production: runs inside a disposable
      // container of the EXACT web image, network none, only /routing mounted.
      const { buildNativeHistoricalCatalogRouting } = await import("../../lib/creative-decision-engine/native-historical-catalog-routing");
      const { persistLocalNativeHistoricalRouting } = await import("../../lib/creative-decision-engine/native-historical-catalog-routing-store");
      const directory = MODE === "production" ? "/routing" : String(request.routingDirectory);
      need(MODE === "production" || directory.startsWith(`${STATE}/`), "OWNED_ROUTING_DIRECTORY");
      const decode = (x: { base64: string; sha256: string }) => { const b = Buffer.from(String(x.base64), "base64");
        need(b.length > 0 && b.length <= 944 * 1024 && sha256(b) === x.sha256, "EXACT_ROUTING_INPUT_BYTES"); return { content: b, sha256: x.sha256 }; };
      need(Array.isArray(request.priorLeaves) && Array.isArray(request.newLeaves) && request.newLeaves.length >= 1 &&
        request.priorLeaves.length + request.newLeaves.length <= 4096, "FINITE_ROUTING_INPUT");
      const publication = buildNativeHistoricalCatalogRouting({ legacy: decode(request.legacy),
        leaves: [...request.priorLeaves, ...request.newLeaves].map(decode) });
      const root = await persistLocalNativeHistoricalRouting(directory, publication);
      return emit({ type: "result", value: { root, files: publication.files.map(f => ({ kind: f.kind, sha256: f.sha256, bytes: f.bytes })) } });
    }
    case "healthcheck-sample": {
      // OWNED host stand-in for adsecute-db-healthcheck: a real statfs of the
      // owned PostgreSQL data volume, written under the fence's required label.
      const fs = await statfs(String(request.pgDataDirectory));
      const db = await client(url, "healthcheck", 8000);
      try {
        const name = (await db.query("SELECT current_database() d")).rows[0].d;
        const total = fs.blocks * fs.bsize, available = fs.bavail * fs.bsize, used = (fs.blocks - fs.bfree) * fs.bsize;
        await db.query(`INSERT INTO system_capacity_snapshots (source,hostname,payload,sampled_at) VALUES ('db_host_healthcheck','owned-local',$1::jsonb,clock_timestamp())`,
          [JSON.stringify({ database: { name }, disks: [{ path: "/var/lib/postgresql", totalBytes: total, usedBytes: used, availableBytes: available }],
            ownedHostSimulation: true })]);
        return emit({ type: "result", value: { availableBytes: available } });
      } finally { await db.end(); }
    }
    case "evidence": {
      // Session census first, on this one client, before the fence opens its own pool.
      const db = await client(url, "evidence", 8000);
      let facts, metadata;
      try {
        await db.query("SET statement_timeout='7500ms'");
        facts = await databaseAdmissionFacts(db, { expectedRole: String(request.expectedRole),
          knownApplicationNames: request.knownApplicationNames, jobRunIds: request.jobRunIds });
        metadata = (await db.query(`SELECT j.id::text id,j.row_count n,(SELECT count(*) FROM public.engine_v3_ad_decision_evaluation_contexts c WHERE c.job_run_id=j.id)::int contexts FROM public.engine_v3_job_runs j WHERE j.id=ANY($1::uuid[])`, [request.jobRunIds])).rows;
      } finally { await db.end(); }
      const { evaluateDbGrowthFence } = await import("../../lib/sync/db-growth-fence");
      const { resetDbClientCache } = await import("../../lib/db");
      try {
        // Only the database budget is passed; table budgets/override stay at code defaults (no override env exists here).
        const business = await evaluateDbGrowthFence({ env: { SYNC_GROWTH_FENCE_DATABASE_BYTES: String(request.databaseBudgetBytes) },
          nowMs: Date.now(), queryTimeoutMs: 8000 });
        return emit({ type: "result", value: { business, facts, metadata } });
      } finally { resetDbClientCache(); }
    }
    case "select": {
      const db = await client(url, "select", 8000);
      try { return emit({ type: "result", value: await selectClosedDayCandidates(db, request.selection) }); }
      finally { await db.end(); }
    }
    case "freeze": case "capture": {
      const db = await client(url, request.op, 8500);
      let collected;
      try { collected = await collectWholeOriginal(db, request.capture); }
      finally { await db.end(); }
      if (request.op === "freeze") return emit({ type: "result", value: { config: collected.config, proofSha256: collected.proofSha256,
        encodedRows: collected.encodedRows } });
      need(collected.proofSha256 === request.frozenProofSha256, "SOURCE_DRIFT_PROOF_MISMATCH");
      const byIdentity = new Map(collected.identities.map(x => [x.evaluationId, x]));
      if (MODE === "production") {
        // The held key arrives ONLY on this process's stdin (from the root actor
        // reading the existing private host env); it is zeroed after sealing and
        // never written. Output: encrypted parts + metadata only.
        need(typeof request.heldKeyHex === "string" && /^[a-f0-9]{64}$/.test(request.heldKeyHex), "HELD_KEY_ON_STDIN_REQUIRED");
        const held = Buffer.from(request.heldKeyHex, "hex"); request.heldKeyHex = undefined;
        try {
          need(sha256(held) === request.heldKeySha256, "EXACT_HELD_KEY_DIGEST");
          const sealed = sealWholeOriginal(collected, String(request.keyId), held);
          const samples = sealed.metadata.parts.flatMap(p => [...new Set([p.firstEvaluationId, p.lastEvaluationId])]).slice(0, 16).map(id => byIdentity.get(id)!);
          return emit({ type: "result", value: { metadata: sealed.metadata, samples, leafBase64: sealed.leaf.toString("base64"),
            parts: sealed.sealedParts.map(p => ({ trustJson: p.trustBytes.toString("utf8"), ciphertextBase64: p.bytes.toString("base64") })),
            sourceRuntime: { node: process.version, build: process.env.APP_BUILD_ID }, sourcePrivateFilesWritten: 0, keyEmitted: false } });
        } finally { held.fill(0); }
      }
      const k = await key();
      const metadata = await sealAndPersist(collected, String(request.keyId), k, String(request.archiveRoot), String(request.copyDirectory));
      await verifyCopies(metadata, k, String(request.archiveRoot), String(request.copyDirectory));
      const samples = metadata.parts.flatMap(p => [...new Set([p.firstEvaluationId, p.lastEvaluationId])]).slice(0, 16).map(id => byIdentity.get(id)!);
      return emit({ type: "result", value: { metadata, samples } });
    }
    case "pins": {
      const c = config(), db = await client(url, "pins", 8500);
      try { return emit({ type: "result", value: await readSelectedPinClosure(db, c) }); } finally { await db.end(); }
    }
    case "restore": {
      const c = config(), k = await key();
      need(/^nsb_restore_[a-f0-9]{12}_[0-9]{2}$/.test(request.restoreDatabase) && /^nsb_restore_[a-f0-9]{12}$/.test(request.templateDatabase), "OWNED_NEW_RESTORE_NAME");
      const admin = await client(url, "restore-admin", 60_000);
      try {
        need((await admin.query("SELECT count(*)::int n FROM pg_database WHERE datname=$1", [request.restoreDatabase])).rows[0].n === 0, "NEW_RESTORE_DATABASE_REQUIRED");
        await admin.query(`CREATE DATABASE "${request.restoreDatabase}" TEMPLATE "${request.templateDatabase}"`);
      } finally { await admin.end(); }
      const target = new URL(url); target.pathname = `/${request.restoreDatabase}`;
      // Operator private restore of a production capture: BOTH private copies
      // (primary + recovery) are read, compared and decrypted; no served copy here.
      const twoPrivate = Array.isArray(request.copyDirectories);
      need(!twoPrivate || request.copyDirectories.length === 2 && request.copyDirectories.every((d: string) => typeof d === "string" && d.startsWith(`${STATE}/`)), "TWO_PRIVATE_COPY_DIRECTORIES");
      const metadata = await readCaptureMetadata(String(twoPrivate ? request.copyDirectories[0] : request.copyDirectory));
      need(metadata.proofSha256 === request.proofSha256, "CAPTURE_PROOF_MISMATCH");
      const whole = twoPrivate ? await verifyPrivateCopies(metadata, k, request.copyDirectories)
        : await verifyCopies(metadata, k, String(request.archiveRoot), String(request.copyDirectory));
      let restored;
      const db = await client(target.toString(), "restore", 8500);
      try { restored = await restoreIntoOwnedNewDatabase(db, whole, c); } finally { await db.end(); }
      let plaintextRestoreDropped = false;
      if (request.dropAfterParity === true) {
        // The restored database holds plaintext rows: drop it right after parity.
        const cleanup = await client(url, "restore-cleanup", 60_000);
        try {
          await cleanup.query(`DROP DATABASE "${request.restoreDatabase}"`);
          plaintextRestoreDropped = (await cleanup.query("SELECT count(*)::int n FROM pg_database WHERE datname=$1", [request.restoreDatabase])).rows[0].n === 0;
        } finally { await cleanup.end(); }
      }
      return emit({ type: "result", value: { ...restored, plaintextRestoreDropped } });
    }
    case "retire": {
      const c = config();
      need(Array.isArray(request.unitLockKey) && request.unitLockKey.length === 2, "UNIT_LOCK_KEY");
      const db = await client(url, "retire", 8500);
      let committed = false;
      try {
        const prepared = await prepareUnitRetirement(db, c, request.proofSha256, request.unitLockKey);
        acceptPrepared(prepared, c);
        const preparedSha256 = sha256(JSON.stringify(prepared)), challengeNonce = randomBytes(16).toString("hex");
        const pendingChallenge = readLine();
        await emit({ type: "prepared", preparedSha256, challengeNonce, prepared });
        const challenge = JSON.parse(await pendingChallenge);
        need(challenge?.action === "COMMIT_EXACT_UNIT_ONCE" && challenge.preparedSha256 === preparedSha256 &&
          challenge.challengeNonce === challengeNonce && challenge.proofSha256 === request.proofSha256 &&
          Object.keys(challenge).sort().join(",") === "action,challengeNonce,preparedSha256,proofSha256", "EXACT_SINGLE_PARENT_COMMIT_CHALLENGE");
        const result = await db.query("COMMIT");
        need(result.command === "COMMIT", "ACTUAL_COMMIT_ACK_REQUIRED"); committed = true;
        return emit({ type: "result", value: { committed: true, preparedSha256 } });
      } finally { if (!committed) await db.query("ROLLBACK").catch(() => undefined); await db.end(); }
    }
    case "readback": {
      const c = config(), db = await client(url, "readback", 8500);
      try { return emit({ type: "result", value: await independentReadback(db, c) }); } finally { await db.end(); }
    }
    case "vacuum": {
      need(request.component === "main" || request.component === "toast", "VACUUM_COMPONENT");
      need(Array.isArray(request.jobRunIds) && request.jobRunIds.every((j: string) => UUID.test(j)), "EXACT_JOB_SET");
      const db = await client(url, `vacuum-${request.component}`, 62_000);
      const notices: string[] = [];
      db.on("notice", n => notices.push(typeof n.code === "string" ? n.code : "notice"));
      try { return emit({ type: "result", value: await vacuumComponent(db, request.component, request.jobRunIds, notices) }); }
      finally { await db.end(); }
    }
    case "space": {
      const db = await client(url, "space", 8000);
      try { return emit({ type: "result", value: await spaceReadback(db) }); } finally { await db.end(); }
    }
  }
}
main().then(() => { process.exitCode = 0; process.stdin.destroy(); },
  async error => { await emit({ type: "error", ...safeError(error) }); process.exitCode = 1; process.stdin.destroy(); });
