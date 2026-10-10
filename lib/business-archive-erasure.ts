import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, statfs, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { PoolClient } from "pg";
import { archiveCanonical, archiveDigest, archiveNeed, assertSafeArchiveDirectory,
  businessArchiveBaseFingerprint, BUSINESS_ARCHIVE_POINTER_CONTRACT, configuredBusinessArchive,
  readSafeArchiveFile, resolveBusinessArchiveConfiguration, scopedArchivePath,
  validateBusinessArchivePointer, type BusinessArchiveConfiguration, type BusinessArchivePointer } from "./business-archive-configuration";
import { openNativeHistoricalArchiveCatalog, openNativeHistoricalArchiveEnvelope,
  type NativeHistoricalArchiveCatalog, type NativeHistoricalArchiveCatalogEntry } from "./creative-decision-engine/native-historical-archive";
import { assertNativeHistoricalRuntimeObjectBound } from "./creative-decision-engine/native-historical-read-controls";
import { buildNativeHistoricalCatalogRouting, NATIVE_HISTORICAL_ROUTING_CONTRACT,
  NATIVE_HISTORICAL_SHARD_CONTRACT } from "./creative-decision-engine/native-historical-catalog-routing";

export const BUSINESS_ARCHIVE_ERASURE_CONTRACT = "business-archive-erasure-plan.v1";
export const BUSINESS_ARCHIVE_ERASURE_BOUNDS = Object.freeze({ files: 256, metadataBytes: 16 * 1024 * 1024,
  inputKeys: 16_384, phaseMs: 120_000, appReserveBytes: 256 * 1024 * 1024 });
export type ArchivedBusinessInputKey = { contractVersion: string; inputHash: string; frozenRowSha256: string | null };
type FileProof = { path: string; sha256: string; bytes: number };
type Publication = FileProof & { contentBase64: string };
export type BusinessArchiveErasurePlan = {
  contract: typeof BUSINESS_ARCHIVE_ERASURE_CONTRACT; businessId: string; baseFingerprint: string;
  before: BusinessArchiveConfiguration; after: BusinessArchiveConfiguration;
  baseline: FileProof[]; remove: string[]; publication: Publication[];
  pointer: BusinessArchivePointer | null; inputKeys: ArchivedBusinessInputKey[]; planSha256: string;
};
export type BusinessArchiveErasureState = { plan: BusinessArchiveErasurePlan; prepared: boolean };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
type InventoryFile = FileProof & { content?: Buffer; catalog?: NativeHistoricalArchiveCatalog };

function checkDeadline(deadlineAtMs: number) { archiveNeed(Date.now() < deadlineAtMs); }
async function fileDigest(path: string, bytes: number, deadlineAtMs = Date.now() + BUSINESS_ARCHIVE_ERASURE_BOUNDS.phaseMs): Promise<string> {
  checkDeadline(deadlineAtMs);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await file.stat();
    archiveNeed(s.isFile() && s.nlink === 1 && !(s.mode & 0o022) && s.size === bytes);
    const { createHash } = await import("node:crypto"), hash = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) { checkDeadline(deadlineAtMs); const r = await file.read(chunk, 0, chunk.length, position); if (!r.bytesRead) break;
      position += r.bytesRead; archiveNeed(position <= bytes); hash.update(chunk.subarray(0, r.bytesRead)); }
    const end = await file.stat();
    archiveNeed(position === bytes && end.mtimeMs === s.mtimeMs && end.ctimeMs === s.ctimeMs && end.size === bytes);
    return hash.digest("hex");
  } finally { await file.close(); }
}
/** Complete, finite local inventory. Unknown paths, symlinks, hard links,
 * writable metadata and orphan ciphertext are owner blockers, never absence. */
export async function inventoryBusinessArchive(root: string, pendingOwnedObjects = new Set<string>(), deadlineAtMs = Date.now() + BUSINESS_ARCHIVE_ERASURE_BOUNDS.phaseMs): Promise<InventoryFile[] & { censusEntries: number }> {
  const files: InventoryFile[] = []; let entries = 0, metadataBytes = 0;
  async function walk(path: string, depth: number) {
    checkDeadline(deadlineAtMs);
    await assertSafeArchiveDirectory(path); archiveNeed(depth <= 3);
    const children = await readdir(path, { withFileTypes: true });
    entries += children.length; archiveNeed(entries <= BUSINESS_ARCHIVE_ERASURE_BOUNDS.files);
    for (const child of children.sort((a, b) => a.name < b.name ? -1 : 1)) {
      checkDeadline(deadlineAtMs);
      archiveNeed(!child.isSymbolicLink()); const full = join(path, child.name);
      if (child.isDirectory()) { await walk(full, depth + 1); continue; }
      archiveNeed(child.isFile()); const name = relative(root, full), s = await lstat(full);
      archiveNeed(s.nlink === 1 && !(s.mode & 0o022) && s.size > 0);
      if (child.name.endsWith(".json")) {
        const pin = /^([a-f0-9]{64})\.json$/.exec(child.name)?.[1], content = await readSafeArchiveFile(full, 1024 * 1024, pin);
        metadataBytes += content.length; archiveNeed(metadataBytes <= BUSINESS_ARCHIVE_ERASURE_BOUNDS.metadataBytes);
        const value = JSON.parse(content.toString("utf8"));
        const catalog = typeof value.contract === "string" && value.contract.startsWith("native-historical-archive-catalog.")
          ? openNativeHistoricalArchiveCatalog(content, archiveDigest(content)) : undefined;
        files.push({ path: name, sha256: archiveDigest(content), bytes: content.length, content, catalog });
      } else {
        archiveNeed(/^native\/v[12]\/[a-f0-9]{64}\.bin$/.test(name) && s.size <= 64 * 1024 * 1024 + 128);
        const sha256 = await fileDigest(full, s.size, deadlineAtMs); archiveNeed(basename(name) === `${sha256}.bin`);
        files.push({ path: name, sha256, bytes: s.size });
      }
    }
  }
  await walk(root, 0);
  const objects = new Set(files.flatMap(f => f.catalog?.entries.map(e => e.object.key) ?? []));
  archiveNeed(files.filter(f => !f.content).every(f => objects.has(f.path) || pendingOwnedObjects.has(f.path)));
  return Object.assign(files, { censusEntries: entries });
}
function filteredCatalog(file: InventoryFile, businessId: string): Buffer {
  archiveNeed(file.catalog && file.content);
  const raw = JSON.parse(file.content.toString("utf8"));
  raw.entries = raw.entries.filter((e: NativeHistoricalArchiveCatalogEntry) => e.generation.businessId !== businessId);
  if (raw.groups) raw.groups = raw.groups.filter((g: { coverageRoot: { core: { generation: { businessId: string } } } }) => g.coverageRoot.core.generation.businessId !== businessId);
  const content = Buffer.from(JSON.stringify(raw));
  openNativeHistoricalArchiveCatalog(content, archiveDigest(content));
  archiveNeed(!content.includes(businessId)); return content;
}
/** Build before the first filesystem mutation; ciphertext authentication and
 * original generation lineage identify every frozen archived input key. */
export async function prepareBusinessArchiveErasurePlan(businessId: string, client: Pick<PoolClient, "query">,
  deadlineAtMs = Date.now() + BUSINESS_ARCHIVE_ERASURE_BOUNDS.phaseMs): Promise<BusinessArchiveErasurePlan> {
  checkDeadline(deadlineAtMs);
  archiveNeed(UUID.test(businessId));
  const before = await resolveBusinessArchiveConfiguration();
  archiveNeed(before.transport === "filesystem" && before.localRoot && before.catalogPath && before.catalogSha256);
  const root = before.localRoot, files = await inventoryBusinessArchive(root, new Set(), deadlineAtMs), byPath = new Map(files.map(f => [f.path, f]));
  const catalog = byPath.get(relative(root, before.catalogPath));
  archiveNeed(catalog?.catalog && catalog.sha256 === before.catalogSha256);
  const selected = new Map<string, NativeHistoricalArchiveCatalogEntry>();
  const foreignObjects = new Set<string>();
  for (const file of files) for (const entry of file.catalog?.entries ?? []) {
    if (entry.generation.businessId === businessId) {
      const previous = selected.get(entry.object.key);
      archiveNeed(!previous || archiveCanonical(previous) === archiveCanonical(entry)); selected.set(entry.object.key, entry);
    } else foreignObjects.add(entry.object.key);
  }
  archiveNeed([...selected.keys()].every(name => !foreignObjects.has(name)));
  const remove = new Set<string>(), publication = new Map<string, Publication>();
  function publish(path: string, content: Buffer) {
    scopedArchivePath(root, path); archiveNeed(content.length <= 1024 * 1024 && !content.includes(businessId));
    const file = { path, bytes: content.length, sha256: archiveDigest(content), contentBase64: content.toString("base64") };
    const old = publication.get(path); archiveNeed(!old || old.sha256 === file.sha256); publication.set(path, file);
  }
  for (const file of files) {
    if (!file.content?.includes(businessId)) continue;
    const value = JSON.parse(file.content.toString("utf8"));
    if (file.catalog) {
      archiveNeed(file.catalog.entries.some(e => e.generation.businessId === businessId));
      const filtered = filteredCatalog(file, businessId);
      if (JSON.parse(filtered.toString("utf8")).entries.length) publish(`filtered/${archiveDigest(filtered)}.json`, filtered);
    } else archiveNeed(value.contract === NATIVE_HISTORICAL_SHARD_CONTRACT
      && value.records?.some((r: { generation: { businessId: string } }) => r.generation.businessId === businessId));
    remove.add(file.path);
  }
  for (const name of selected.keys()) { archiveNeed(byPath.has(name)); remove.add(name); }
  // Roots do not contain the business UUID: follow the exact affected legacy/
  // shard digest dependencies, including inactive/staged routing copies.
  const removedDigests = new Set([...remove].map(p => byPath.get(p)!.sha256));
  for (const file of files) if (file.content) {
    const value = JSON.parse(file.content.toString("utf8"));
    if (value.contract === NATIVE_HISTORICAL_ROUTING_CONTRACT
      && (removedDigests.has(value.legacy?.sha256) || value.shards?.some((s: { sha256: string }) => removedDigests.has(s.sha256)))) remove.add(file.path);
  }
  const keys = new Map<string, ArchivedBusinessInputKey>();
  for (const entry of selected.values()) {
    checkDeadline(deadlineAtMs);
    assertNativeHistoricalRuntimeObjectBound(entry);
    archiveNeed(entry.encryptionKeyId === process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID
      && /^[a-f0-9]{64}$/.test(process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX ?? ""));
    const bytes = await readSafeArchiveFile(scopedArchivePath(root, entry.object.key), entry.ciphertextBytes, entry.ciphertextSha256);
    const opened = openNativeHistoricalArchiveEnvelope(bytes, entry,
      Buffer.from(process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX!, "hex"), entry.generation);
    for (const row of opened.view.readCoreTable("engine_v3_ad_decision_input_evidence")) {
      const input = JSON.parse(row.rowJson), contractVersion = input.contract_version, inputHash = input.input_hash;
      archiveNeed(typeof contractVersion === "string" && contractVersion.length <= 256 && SHA.test(inputHash));
      keys.set(`${contractVersion}:${inputHash}`, { contractVersion, inputHash, frozenRowSha256: null });
      archiveNeed(keys.size <= BUSINESS_ARCHIVE_ERASURE_BOUNDS.inputKeys);
    }
  }
  for (const key of keys.values()) {
    checkDeadline(deadlineAtMs);
    const query = "SELECT to_jsonb(i)::text AS row_json FROM public.engine_v3_ad_decision_input_evidence i WHERE contract_version=$1::text AND input_hash=$2::character(64)";
    const { rows: [plan] } = await client.query(`EXPLAIN (FORMAT JSON) ${query}`, [key.contractVersion, key.inputHash]);
    assertArchivedInputPointPlan(plan["QUERY PLAN"][0].Plan);
    const { rows } = await client.query<{ row_json: string }>(query, [key.contractVersion, key.inputHash]);
    archiveNeed(rows.length <= 1); key.frozenRowSha256 = rows[0] ? archiveDigest(rows[0].row_json) : null;
  }
  let after = before, pointer: BusinessArchivePointer | null = null;
  if (remove.size) {
    const legacy = filteredCatalog(catalog, businessId), legacySha = archiveDigest(legacy);
    const legacyPath = `filtered/${legacySha}.json`; publish(legacyPath, legacy);
    after = { ...before, catalogPath: scopedArchivePath(root, legacyPath), catalogSha256: legacySha };
    pointer = { contract: BUSINESS_ARCHIVE_POINTER_CONTRACT, baseFingerprint: businessArchiveBaseFingerprint(),
      catalog: { path: legacyPath, sha256: legacySha }, routing: null };
    if (before.routingEnabled) {
      archiveNeed(before.routingDirectory && before.rootSha256);
      const currentRoot = await readSafeArchiveFile(join(before.routingDirectory, "root", `${before.rootSha256}.json`), 1024 * 1024, before.rootSha256);
      const descriptor = JSON.parse(currentRoot.toString("utf8")), leaves: { content: Buffer; sha256: string }[] = [], allLeaves: typeof leaves = [];
      archiveNeed(descriptor.contract === NATIVE_HISTORICAL_ROUTING_CONTRACT && descriptor.legacy.sha256 === before.catalogSha256
        && descriptor.shards.length <= 256);
      for (const ref of descriptor.shards) {
        checkDeadline(deadlineAtMs);
        const bytes = await readSafeArchiveFile(join(before.routingDirectory, "shard", `${ref.sha256}.json`), ref.bytes, ref.sha256);
        const shard = JSON.parse(bytes.toString("utf8")); archiveNeed(shard.contract === NATIVE_HISTORICAL_SHARD_CONTRACT && shard.records.length <= 128);
        for (const record of shard.records) {
          checkDeadline(deadlineAtMs);
          const content = await readSafeArchiveFile(join(before.routingDirectory, "leaf", `${record.leaf.sha256}.json`), record.leaf.bytes, record.leaf.sha256);
          allLeaves.push({ content, sha256: record.leaf.sha256 });
          if (record.generation.businessId !== businessId) leaves.push({ content, sha256: record.leaf.sha256 });
        }
      }
      archiveNeed(buildNativeHistoricalCatalogRouting({ legacy: { content: catalog.content!, sha256: catalog.sha256 }, leaves: allLeaves }).root.sha256 === before.rootSha256);
      const filtered = buildNativeHistoricalCatalogRouting({ legacy: { content: legacy, sha256: legacySha }, leaves });
      const directory = `routing-auto-${filtered.root.sha256.slice(0, 24)}`;
      for (const f of filtered.files) publish(`${directory}/${f.kind}/${f.sha256}.json`, f.content);
      pointer.routing = { directory, sha256: filtered.root.sha256 };
      after = { ...after, routingDirectory: scopedArchivePath(root, directory), rootSha256: filtered.root.sha256 };
    }
  }
  const newPaths = [...publication.keys()].filter(p => !byPath.has(p));
  // Count distinct new parents, not three copies of the SAME directory for
  // every leaf. Existing empty directories may conservatively count again.
  const parents=(p:string)=>p.split("/").slice(0,-1).map((_s,i)=>p.split("/").slice(0,i+1).join("/"));
  const knownParents=new Set(files.flatMap(f=>parents(f.path)));
  const newParents=new Set(newPaths.flatMap(parents).filter(p=>!knownParents.has(p)));
  archiveNeed(files.censusEntries + newPaths.length + newParents.size <= BUSINESS_ARCHIVE_ERASURE_BOUNDS.files);
  const body: Omit<BusinessArchiveErasurePlan, "planSha256"> = { contract: BUSINESS_ARCHIVE_ERASURE_CONTRACT, businessId, baseFingerprint: businessArchiveBaseFingerprint(),
    before, after, baseline: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    remove: [...remove].sort(), publication: [...publication.values()], pointer, inputKeys: [...keys.values()] };
  return { ...body, planSha256: archiveDigest(archiveCanonical(body)) };
}
export function assertArchivedInputPointPlan(node: Record<string, unknown>) {
  archiveNeed(["Index Scan", "Index Only Scan"].includes(String(node["Node Type"]))
    && /contract_version.*=/.test(String(node["Index Cond"])) && /input_hash.*=/.test(String(node["Index Cond"])));
}
export function validateBusinessArchiveErasurePlan(plan: BusinessArchiveErasurePlan, businessId: string) {
  const { planSha256, ...body } = plan;
  archiveNeed(plan.contract === BUSINESS_ARCHIVE_ERASURE_CONTRACT && UUID.test(businessId) && plan.businessId === businessId
    && plan.baseFingerprint === businessArchiveBaseFingerprint() && planSha256 === archiveDigest(archiveCanonical(body))
    && plan.baseline.length <= BUSINESS_ARCHIVE_ERASURE_BOUNDS.files && plan.inputKeys.length <= BUSINESS_ARCHIVE_ERASURE_BOUNDS.inputKeys
    && plan.before.localRoot === configuredBusinessArchive().localRoot && plan.after.localRoot === plan.before.localRoot);
  const all = new Map(plan.baseline.map(f => [f.path, f])); archiveNeed(all.size === plan.baseline.length);
  for (const f of plan.baseline) { scopedArchivePath(plan.before.localRoot!, f.path); archiveNeed(SHA.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes > 0); }
  archiveNeed(new Set(plan.remove).size === plan.remove.length && plan.remove.every(p => all.has(p)));
  for (const f of plan.publication) {
    scopedArchivePath(plan.before.localRoot!, f.path);
    const bytes = Buffer.from(f.contentBase64, "base64"); archiveNeed(bytes.length === f.bytes && bytes.length <= 1024 * 1024
      && archiveDigest(bytes) === f.sha256 && !bytes.includes(businessId) && !plan.remove.includes(f.path));
  }
  archiveNeed(new Set(plan.publication.map(f=>f.path)).size===plan.publication.length
    && new Set(plan.inputKeys.map(k=>`${k.contractVersion}:${k.inputHash}`)).size===plan.inputKeys.length
    && plan.before.transport === "filesystem" && plan.after.transport === plan.before.transport
    && plan.before.routingEnabled === configuredBusinessArchive().routingEnabled
    && plan.after.routingEnabled === plan.before.routingEnabled);
  for (const key of plan.inputKeys) archiveNeed(typeof key.contractVersion === "string" && key.contractVersion.length <= 256
    && SHA.test(key.inputHash) && (key.frozenRowSha256 === null || SHA.test(key.frozenRowSha256)));
  if (plan.pointer) {
    validateBusinessArchivePointer(plan.pointer, configuredBusinessArchive());
    archiveNeed(archiveCanonical(plan.after)===archiveCanonical({...plan.before,
      catalogPath:scopedArchivePath(plan.before.localRoot!,plan.pointer.catalog.path),catalogSha256:plan.pointer.catalog.sha256,
      routingDirectory:plan.pointer.routing?scopedArchivePath(plan.before.localRoot!,plan.pointer.routing.directory):null,
      rootSha256:plan.pointer.routing?.sha256??null}));
  }
  else archiveNeed(!plan.remove.length && !plan.publication.length);
}
async function syncDirectory(path: string) {
  const f = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await f.sync(); } finally { await f.close(); }
}
async function discardOwnInterruptedWrite(path: string, bytes: Buffer) {
  try {
    await assertSafeArchiveDirectory(dirname(path));
    const f=await open(path+".writing",constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const s=await f.stat();archiveNeed(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<=bytes.length);
      const partial=await f.readFile();archiveNeed(partial.equals(bytes.subarray(0,partial.length)));
    }finally{await f.close();}
    await unlink(path+".writing");await syncDirectory(dirname(path));
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
}
async function writeOnce(path: string, bytes: Buffer) {
  // The final name is visible only after a full fsync. A persisted plan owns
  // the exact .writing prefix, so process loss cannot strand a corrupt catalog.
  try{await lstat(path);throw Object.assign(new Error("archive publication exists"),{code:"EEXIST"});}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  await discardOwnInterruptedWrite(path,bytes);
  const f = await open(path+".writing", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  await rename(path+".writing",path);
  await syncDirectory(dirname(path));
}
/** Idempotent saga: durable frozen plan -> immutable publication -> atomic
 * active pointer -> exact unlink -> whole-scope absence. A crash can leave
 * owned copies pending, but cannot report physical success or restore access. */
export async function applyBusinessArchiveErasurePlan(plan: BusinessArchiveErasurePlan,
  deadlineAtMs: number, onPhase?: (phase: "published" | "purging" | "verified") => Promise<void>) {
  validateBusinessArchiveErasurePlan(plan, plan.businessId);
  const root = plan.before.localRoot!;
  const deadline = () => archiveNeed(Date.now() < deadlineAtMs);
  deadline();await assertSafeArchiveDirectory(root);
  for(const f of plan.publication){deadline();await discardOwnInterruptedWrite(scopedArchivePath(root,f.path),Buffer.from(f.contentBase64,"base64"));}
  const expected = new Map(plan.baseline.map(f => [f.path, f]));
  for (const f of plan.publication) expected.set(f.path, f);
  async function verify() {
    deadline(); const actual = await inventoryBusinessArchive(root, new Set(plan.remove.filter(p => p.endsWith(".bin"))), deadlineAtMs);
    for (const file of actual) { const known = expected.get(file.path); archiveNeed(known && file.sha256 === known.sha256 && file.bytes === known.bytes); }
    const paths = new Set(actual.map(f => f.path));
    archiveNeed(plan.baseline.every(f => paths.has(f.path) || plan.remove.includes(f.path)));
    return paths;
  }
  const beforePaths = await verify();
  if (plan.publication.length) {
    const space = await statfs(root), newBytes = plan.publication.filter(f => !beforePaths.has(f.path)).reduce((n, f) => n + f.bytes, 0);
    archiveNeed(space.bavail * space.bsize >= newBytes + BUSINESS_ARCHIVE_ERASURE_BOUNDS.appReserveBytes);
  }
  for (const f of plan.publication) {
    deadline(); const path = scopedArchivePath(root, f.path), parents = relative(root, dirname(path)).split("/"); let parent = root;
    for (const name of parents) { parent = join(parent, name); await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; }); await assertSafeArchiveDirectory(parent); }
    try { await writeOnce(path, Buffer.from(f.contentBase64, "base64")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await readSafeArchiveFile(path, f.bytes, f.sha256); }
  }
  if (plan.pointer) {
    const filename = process.env.ENGINE_V3_NATIVE_ARCHIVE_ACTIVE_POINTER;
    archiveNeed(filename && basename(filename) === "active.json"); await assertSafeArchiveDirectory(dirname(filename));
    const current = await resolveBusinessArchiveConfiguration();
    archiveNeed(archiveCanonical(current) === archiveCanonical(plan.before) || archiveCanonical(current) === archiveCanonical(plan.after));
    const bytes = Buffer.from(JSON.stringify(plan.pointer)), pending = join(dirname(filename), `active-${archiveDigest(bytes)}.pending`);
    try { await writeOnce(pending, bytes); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await readSafeArchiveFile(pending, 4096, archiveDigest(bytes)); }
    deadline(); await rename(pending, filename); await syncDirectory(dirname(filename));
    archiveNeed(archiveCanonical(await resolveBusinessArchiveConfiguration()) === archiveCanonical(plan.after));
  }
  await onPhase?.("published");
  await verify(); await onPhase?.("purging");
  for (const name of plan.remove) {
    deadline(); const path = scopedArchivePath(root, name), expectedFile = expected.get(name)!;
    try { archiveNeed(await fileDigest(path, expectedFile.bytes, deadlineAtMs) === expectedFile.sha256); deadline(); await unlink(path); await syncDirectory(dirname(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const finalPaths = await verify();
  archiveNeed(plan.remove.every(p => !finalPaths.has(p)) && plan.publication.every(f => finalPaths.has(f.path)));
  // Verify target absence in all inactive/staged JSON, not just served routing.
  const final = await inventoryBusinessArchive(root, new Set(), deadlineAtMs); archiveNeed(final.every(f => !f.content?.includes(plan.businessId)));
  await onPhase?.("verified");
}
