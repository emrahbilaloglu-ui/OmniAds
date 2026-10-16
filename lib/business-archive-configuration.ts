import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

export const BUSINESS_ARCHIVE_POINTER_CONTRACT = "business-archive-active-publication.v1";
export const BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT = "business-archive-active-publication.v2";
export const BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY = "routing-cas-v1";
export const archiveDigest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const archiveCanonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export class BusinessArchiveConfigurationError extends Error {
  constructor() { super("archive_configuration_invalid"); }
}
export function archiveNeed(condition: unknown): asserts condition {
  if (!condition) throw new BusinessArchiveConfigurationError();
}
export type BusinessArchiveConfiguration = {
  catalogPath: string | null; catalogSha256: string | null;
  routingEnabled: boolean; routingDirectory: string | null; rootSha256: string | null;
  localRoot: string | null; transport: string | null;
};
export function configuredBusinessArchive(): BusinessArchiveConfiguration {
  return {
    catalogPath: process.env.ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH || null,
    catalogSha256: process.env.ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256 || null,
    routingEnabled: process.env.ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED === "true",
    routingDirectory: process.env.ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT || null,
    rootSha256: process.env.ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256 || null,
    localRoot: process.env.ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT || null,
    transport: process.env.ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT || null,
  };
}
export function businessArchiveBaseFingerprint() { return archiveDigest(archiveCanonical(configuredBusinessArchive())); }
export async function assertSafeArchiveDirectory(path: string) {
  archiveNeed(isAbsolute(path) && await realpath(path) === path);
  const s = await lstat(path);
  archiveNeed(s.isDirectory() && !s.isSymbolicLink() && !(s.mode & 0o022));
}
export function scopedArchivePath(root: string, name: string) {
  archiveNeed(isAbsolute(root) && typeof name === "string" && name.length > 0
    && !isAbsolute(name) && !name.split("/").some(p => p === ".." || p === "." || !p));
  const path = join(root, name);
  archiveNeed(relative(root, path) === name);
  return path;
}
export async function readSafeArchiveFile(path: string, maxBytes = 1024 * 1024, sha?: string): Promise<Buffer> {
  archiveNeed(isAbsolute(path) && (sha === undefined || /^[a-f0-9]{64}$/.test(sha)));
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await f.stat();
    archiveNeed(s.isFile() && s.nlink === 1 && !(s.mode & 0o022) && s.size > 0 && s.size <= maxBytes);
    const b = Buffer.alloc(s.size + 1), r = await f.read(b, 0, b.length, 0), end = await f.stat();
    archiveNeed(r.bytesRead === s.size && end.size === s.size && end.mtimeMs === s.mtimeMs && end.ctimeMs === s.ctimeMs);
    const bytes = b.subarray(0, r.bytesRead);
    archiveNeed(sha === undefined || archiveDigest(bytes) === sha);
    return bytes;
  } finally { await f.close(); }
}
export type BusinessArchivePointer = {
  contract: typeof BUSINESS_ARCHIVE_POINTER_CONTRACT | typeof BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT; baseFingerprint: string;
  catalog: { path: string; sha256: string };
  routing: { directory: string; sha256: string } | null;
};
export function validateBusinessArchivePointer(value: unknown, base: BusinessArchiveConfiguration): BusinessArchivePointer {
  archiveNeed(value && typeof value === "object" && !Array.isArray(value));
  const p = value as BusinessArchivePointer;
  archiveNeed(Object.keys(p).sort().join(",") === "baseFingerprint,catalog,contract,routing"
    && [BUSINESS_ARCHIVE_POINTER_CONTRACT,BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT].includes(p.contract)
    && (p.contract!==BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT||base.routingEnabled)
    && p.baseFingerprint === businessArchiveBaseFingerprint()
    && base.localRoot && base.transport === "filesystem" && p.catalog
    && Object.keys(p.catalog).sort().join(",") === "path,sha256"
    && /^[a-f0-9]{64}$/.test(p.catalog.sha256)
    && p.catalog.path === `filtered/${p.catalog.sha256}.json`);
  scopedArchivePath(base.localRoot, p.catalog.path);
  if (base.routingEnabled) {
    archiveNeed(p.routing && Object.keys(p.routing).sort().join(",") === "directory,sha256" && /^[a-f0-9]{64}$/.test(p.routing.sha256)
      && p.routing.directory === (p.contract===BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT
        ? BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY : `routing-auto-${p.routing.sha256.slice(0, 24)}`));
    scopedArchivePath(base.localRoot, p.routing.directory);
  } else archiveNeed(p.routing === null);
  return p;
}
/** Caller holds the shared publisher/offboarding exclusion. Exact pre-state
 * compare prevents stale publication from undoing a completed business erase.
 * Existing immutable metadata must have been fully verified before this call. */
export async function activateBusinessArchivePointer(pointer:BusinessArchivePointer,expected:BusinessArchiveConfiguration) {
  validateBusinessArchivePointer(pointer,configuredBusinessArchive());
  const filename=process.env.ENGINE_V3_NATIVE_ARCHIVE_ACTIVE_POINTER;
  archiveNeed(filename&&isAbsolute(filename)&&basename(filename)==="active.json");
  const parent=dirname(filename);await assertSafeArchiveDirectory(parent);
  archiveNeed(archiveCanonical(await resolveBusinessArchiveConfiguration())===archiveCanonical(expected));
  const bytes=Buffer.from(JSON.stringify(pointer)),temporary=join(parent,`active-${archiveDigest(bytes)}.pending`);
  // Only an exact complete previous intent can be reused. Partial/foreign
  // files block the publisher; they never become an active pointer.
  let existed=false;
  try{
    const old=await open(temporary,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let complete=false;
    try{const s=await old.stat();archiveNeed(s.isFile()&&s.nlink===1&&!(s.mode&0o077)&&s.size<=bytes.length);
      const b=Buffer.alloc(s.size+1),r=await old.read(b,0,b.length,0),end=await old.stat();
      archiveNeed(r.bytesRead===s.size&&end.size===s.size&&end.mtimeMs===s.mtimeMs&&end.ctimeMs===s.ctimeMs&&
        b.subarray(0,r.bytesRead).equals(bytes.subarray(0,s.size)));complete=s.size===bytes.length;
    }finally{await old.close();}
    if(complete)existed=true;else await unlink(temporary);
  }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  if(!existed){const f=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await f.writeFile(bytes);await f.sync();}catch(e){await unlink(temporary).catch(()=>undefined);throw e;}finally{await f.close();}}
  archiveNeed(archiveCanonical(await resolveBusinessArchiveConfiguration())===archiveCanonical(expected));
  await rename(temporary,filename);
  const directory=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await directory.sync();}finally{await directory.close();}
  const actual=await resolveBusinessArchiveConfiguration();
  archiveNeed(actual.rootSha256===(pointer.routing?.sha256??null)&&actual.catalogSha256===pointer.catalog.sha256);
  return actual;
}
/** The writer is the dedicated offboarding role, never a buyer/API request.
 * Every reader reloads the atomic pointer before routing/cache admission.
 * The immutable catalog, shard, leaf and encrypted-object verifiers stay active. */
export async function resolveBusinessArchiveConfiguration(): Promise<BusinessArchiveConfiguration> {
  const base = configuredBusinessArchive(), filename = process.env.ENGINE_V3_NATIVE_ARCHIVE_ACTIVE_POINTER;
  if (!filename) return base;
  archiveNeed(isAbsolute(filename) && basename(filename) === "active.json");
  await assertSafeArchiveDirectory(dirname(filename));
  let bytes: Buffer;
  try { bytes = await readSafeArchiveFile(filename, 4096); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return base; throw error; }
  const p = validateBusinessArchivePointer(JSON.parse(bytes.toString("utf8")), base);
  return { ...base, catalogPath: scopedArchivePath(base.localRoot!, p.catalog.path), catalogSha256: p.catalog.sha256,
    routingDirectory: p.routing ? scopedArchivePath(base.localRoot!, p.routing.directory) : null,
    rootSha256: p.routing?.sha256 ?? null };
}
