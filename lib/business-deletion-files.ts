import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { getDb } from "@/lib/db";
import { openNativeHistoricalArchiveCatalog } from "@/lib/creative-decision-engine/native-historical-archive";
import { buildNativeHistoricalCatalogRouting } from "@/lib/creative-decision-engine/native-historical-catalog-routing";
import { resolveBusinessArchiveConfiguration } from "@/lib/business-archive-configuration";

export class BusinessExternalCleanupError extends Error {}
function refuse(): never { throw new BusinessExternalCleanupError("external_cleanup_required"); }
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function metadata(path: string, sha?: string, exactBytes?: number): Promise<Buffer> {
  if (!isAbsolute(path) || sha !== undefined && !/^[a-f0-9]{64}$/.test(sha)) refuse();
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await f.stat();
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o022) !== 0 || s.size <= 0 || s.size > 1024 * 1024
      || exactBytes !== undefined && s.size !== exactBytes) refuse();
    const b = Buffer.alloc(s.size + 1), r = await f.read(b, 0, b.length, 0);
    const end = await f.stat();
    if (r.bytesRead !== s.size || end.size !== s.size || end.mtimeMs !== s.mtimeMs || end.ctimeMs !== s.ctimeMs) refuse();
    const bytes = b.subarray(0, r.bytesRead); if (sha !== undefined && digest(bytes) !== sha) refuse(); return bytes;
  } finally { await f.close(); }
}

/** A read-only native archive must be explicitly purged before its business can
 * disappear. Never return successful erasure while a historical copy is served.
 * Exact pinned metadata is inspected; ciphertext, keys and other tenants stay intact. */
export async function assertNoBusinessNativeArchive(businessId: string) {
  const configuration = await resolveBusinessArchiveConfiguration();
  const path = configuration.catalogPath;
  if (!path) {
    if (process.env.ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED === "true"
      || process.env.ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED === "true") refuse();
    return;
  }
  const sha = configuration.catalogSha256;
  if (!sha) refuse();
  const legacy = await metadata(path, sha);
  const catalog = openNativeHistoricalArchiveCatalog(legacy, sha);
  if (catalog.entries.some(e => e.generation.businessId === businessId)) refuse();
  if (!configuration.routingEnabled) { await assertNoLocalCopies(businessId); return; }
  const directory = configuration.routingDirectory;
  const rootSha = configuration.rootSha256;
  if (!directory || !rootSha || !isAbsolute(directory) || await realpath(directory) !== directory) refuse();
  const rootBytes = await metadata(join(directory, "root", `${rootSha}.json`), rootSha);
  const root = JSON.parse(rootBytes.toString("utf8")) as { shards: { sha256: string; bytes: number }[] };
  if (!Array.isArray(root.shards) || root.shards.length > 256) refuse();
  const leaves: { content: Buffer; sha256: string }[] = [];
  const seen = new Set<string>(); let total = legacy.length + rootBytes.length;
  for (const ref of root.shards) {
    const bytes = await metadata(join(directory, "shard", `${ref.sha256}.json`), ref.sha256, ref.bytes);
    total += bytes.length; if (total > 8 * 1024 * 1024) refuse();
    const shard = JSON.parse(bytes.toString("utf8")) as { records: { generation: { businessId: string }; leaf: { sha256: string; bytes: number } }[] };
    if (!Array.isArray(shard.records) || shard.records.length > 128) refuse();
    for (const r of shard.records) {
      if (r.generation?.businessId === businessId || seen.has(r.leaf.sha256)) refuse();
      seen.add(r.leaf.sha256);
      const content = await metadata(join(directory, "leaf", `${r.leaf.sha256}.json`), r.leaf.sha256, r.leaf.bytes);
      total += content.length; if (total > 8 * 1024 * 1024 || leaves.length >= 128) refuse();
      leaves.push({ content, sha256: r.leaf.sha256 });
    }
  }
  // Reconstruct and verify the complete generation routing; malformed or
  // incomplete metadata is a blocker, never an inferred absence.
  const publication = buildNativeHistoricalCatalogRouting({ legacy: { content: legacy, sha256: sha }, leaves });
  if (publication.root.sha256 !== rootSha) refuse();
  await assertNoLocalCopies(businessId);
}

/** Inactive/staged catalogs are still copies. A finite local census also refuses
 * orphan ciphertext whose owner cannot be established from any verified catalog. */
async function assertNoLocalCopies(businessId: string) {
  const root = process.env.ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT;
  if (process.env.ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT !== "filesystem" || !root
    || !isAbsolute(root) || await realpath(root) !== root) refuse();
  const owners = new Set<string>(), objects: string[] = [];
  let count = 0, total = 0;
  async function walk(path: string, depth: number): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || await realpath(path) !== path || depth > 3) refuse();
    const entries = await readdir(path, { withFileTypes: true });
    count += entries.length; if (count > 256) refuse();
    for (const e of entries) {
      if (e.isSymbolicLink()) refuse();
      const file = join(path, e.name);
      if (e.isDirectory()) { await walk(file, depth + 1); continue; }
      if (!e.isFile()) refuse();
      if (e.name.endsWith(".json")) {
        const pin = /^([a-f0-9]{64})\.json$/.exec(e.name)?.[1];
        const bytes = await metadata(file, pin); total += bytes.length;
        if (total > 16 * 1024 * 1024 || bytes.includes(businessId)) refuse();
        const value = JSON.parse(bytes.toString("utf8"));
        if (typeof value.contract === "string" && value.contract.startsWith("native-historical-archive-catalog.")) {
          const catalog = openNativeHistoricalArchiveCatalog(bytes, digest(bytes));
          for (const entry of catalog.entries) owners.add(entry.ciphertextSha256);
        }
      } else if (/^[a-f0-9]{64}\.bin$/.test(e.name) && /\/native\/v[12]$/.test(path)) {
        objects.push(e.name.slice(0, -4));
      } else refuse();
    }
  }
  await walk(root, 0);
  if (objects.some(object => !owners.has(object))) refuse();
}

async function purgeMediaCache(businessId: string) {
  const keys = await getDb()<{ storage_key: string }>`SELECT storage_key FROM creative_media_cache
    WHERE business_id=${businessId} AND storage_key IS NOT NULL LIMIT 5001`;
  if (keys.length > 5000 || keys.some(r => !new RegExp(`^[a-z_]+/${businessId}/[^/]+$`).test(r.storage_key))) refuse();
  const base = resolve(process.cwd(), ".cache", "media");
  let entries;
  try {
    const s = await lstat(base); if (!s.isDirectory() || s.isSymbolicLink() || await realpath(base) !== base) refuse();
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (entries.length > 32) refuse();
  const targets: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || !/^[a-z_]+$/.test(e.name)) refuse();
    const target = join(base, e.name, businessId);
    try {
      const s = await lstat(target); if (!s.isDirectory() || s.isSymbolicLink() || await realpath(target) !== target) refuse();
      targets.push(target);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // These are derived media copies, scoped by the exact business UUID. Cache
  // eviction can survive a later DB rollback; warehouse/access still roll back.
  for (const target of targets) await rm(target, { recursive: true, force: false });
  for (const target of targets) {
    try { await lstat(target); refuse(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function assertBusinessExternalDataRemoved(businessId: string): Promise<void> {
  try { await assertNoBusinessNativeArchive(businessId); await purgeMediaCache(businessId); }
  catch (error) { if (error instanceof BusinessExternalCleanupError) throw error; refuse(); }
}
