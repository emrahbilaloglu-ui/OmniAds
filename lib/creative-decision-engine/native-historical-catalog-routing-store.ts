import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { nativeArchiveByteDigest } from "./native-historical-archive";
import { withLocalNativeArchiveRead } from "./native-historical-local-store";
import { buildNativeHistoricalCatalogRouting, NATIVE_HISTORICAL_ROUTING_BOUNDS, NATIVE_HISTORICAL_ROUTING_CONTRACT,
  type NativeHistoricalMetadataRead, type NativeHistoricalMetadataKind, type NativeHistoricalRoutingPublication } from "./native-historical-catalog-routing";

function refuse(): never { throw new Error("native_historical_catalog_metadata_file_refused"); }
const caps: Record<NativeHistoricalMetadataKind, number> = {
  root: NATIVE_HISTORICAL_ROUTING_BOUNDS.rootBytes, legacy: NATIVE_HISTORICAL_ROUTING_BOUNDS.legacyBytes,
  shard: NATIVE_HISTORICAL_ROUTING_BOUNDS.shardBytes, leaf: NATIVE_HISTORICAL_ROUTING_BOUNDS.leafBytes,
};
function reference(r: NativeHistoricalMetadataRead) {
  if (!Object.hasOwn(caps, r.kind) || !/^[a-f0-9]{64}$/.test(r.sha256) || r.maxBytes !== caps[r.kind] ||
      r.bytes !== undefined && (!Number.isSafeInteger(r.bytes) || r.bytes <= 0 || r.bytes > caps[r.kind])) refuse();
}
function abort(signal: AbortSignal) { if (signal.aborted) refuse(); }
async function directory(root: string, kind: NativeHistoricalMetadataKind, signal?: AbortSignal) {
  if (signal) abort(signal);
  if (!isAbsolute(root) || resolve(root) !== root || root === "/" || await realpath(root) !== root) refuse();
  const base = await lstat(root), path = join(root, kind);
  if (!base.isDirectory() || base.isSymbolicLink() || (base.mode & 0o022) !== 0) refuse();
  if (signal) abort(signal);
  const component = await lstat(path);
  if (!component.isDirectory() || component.isSymbolicLink() || (component.mode & 0o022) !== 0 ||
      component.uid !== base.uid || await realpath(path) !== path) refuse();
  return { path, uid: base.uid, rootDev: base.dev, rootIno: base.ino, dev: component.dev, ino: component.ino };
}

/** Configured canonical read-only root + fixed kind/digest names only. The same
 * genuinely outstanding I/O slot fences metadata and evidence reads. Deadline
 * expiry cannot release the slot before the late descriptor actually closes. */
export async function readLocalNativeHistoricalMetadata(root: string, ref: NativeHistoricalMetadataRead,
  externalSignal?: AbortSignal): Promise<Buffer> {
  reference(ref);
  return withLocalNativeArchiveRead(async signal => {
    const dir = await directory(root, ref.kind, signal); abort(signal);
    const filename = join(dir.path, `${ref.sha256}.json`);
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      abort(signal); const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== dir.uid || (stat.mode & 0o022) !== 0 ||
          stat.size <= 0 || stat.size > ref.maxBytes || ref.bytes !== undefined && stat.size !== ref.bytes) refuse();
      // Allocate only after the independent fixed cap/stat/exact-length checks.
      const buffer = Buffer.alloc(stat.size + 1); abort(signal);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); abort(signal);
      const end = await file.stat(), named = await lstat(filename), endDir = await directory(root, ref.kind, signal);
      if (bytesRead !== stat.size || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || end.ctimeMs !== stat.ctimeMs ||
          end.nlink !== 1 || end.uid !== dir.uid || (end.mode & 0o022) !== 0 || named.isSymbolicLink() ||
          named.dev !== stat.dev || named.ino !== stat.ino || endDir.uid !== dir.uid || endDir.dev !== dir.dev || endDir.ino !== dir.ino ||
          endDir.rootDev !== dir.rootDev || endDir.rootIno !== dir.rootIno || nativeArchiveByteDigest(buffer.subarray(0, bytesRead)) !== ref.sha256) refuse();
      return buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
  }, externalSignal);
}

/** Explicit OFFLINE operator only, called on an owned staging root. Publishes
 * digest-named immutable files, never replaces one, and removes only its own
 * temporary names. No environment/root activation, ciphertext capture/upload,
 * source deletion, GC, provider authority or production disk permission. */
export async function persistLocalNativeHistoricalRouting(root: string, publication: NativeHistoricalRoutingPublication) {
  if (publication.contract !== NATIVE_HISTORICAL_ROUTING_CONTRACT || publication.providerAuthority !== false ||
      publication.reclaimEligible !== false) refuse();
  const legacy = publication.files.filter(f => f.kind === "legacy"), roots = publication.files.filter(f => f.kind === "root");
  if (legacy.length !== 1 || roots.length !== 1) refuse();
  const verified = buildNativeHistoricalCatalogRouting({ legacy: { content: legacy[0]!.content, sha256: legacy[0]!.sha256 },
    leaves: publication.files.filter(f => f.kind === "leaf").map(f => ({ content: f.content, sha256: f.sha256 })) });
  const inventory = (p: NativeHistoricalRoutingPublication) => JSON.stringify(p.files.map(f => {
    reference({ ...f, maxBytes: caps[f.kind] });
    if (f.bytes !== f.content.length || nativeArchiveByteDigest(f.content) !== f.sha256) refuse();
    return [f.kind, f.sha256, f.bytes];
  }).sort());
  if (verified.root.sha256 !== publication.root.sha256 || verified.root.bytes !== publication.root.bytes ||
      roots[0]!.sha256 !== verified.root.sha256 || inventory(verified) !== inventory(publication)) refuse();
  if (!isAbsolute(root) || resolve(root) !== root || root === "/" || await realpath(root) !== root) refuse();
  const base = await lstat(root);
  if (!base.isDirectory() || base.isSymbolicLink() || (base.mode & 0o022) !== 0 || base.uid !== process.getuid?.()) refuse();
  for (const kind of Object.keys(caps) as NativeHistoricalMetadataKind[]) {
    await mkdir(join(root, kind), { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await directory(root, kind);
  }
  for (const f of publication.files) {
    const dir = await directory(root, f.kind), target = join(dir.path, `${f.sha256}.json`);
    const temporary = join(dir.path, `.pending-${randomUUID()}`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(f.content); await file.chmod(0o440); await file.sync(); }
      finally { await file.close(); }
      await link(temporary, target).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    } finally { await unlink(temporary); }
    const handle = await open(dir.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    await readLocalNativeHistoricalMetadata(root, { kind: f.kind, sha256: f.sha256, bytes: f.bytes, maxBytes: caps[f.kind] });
  }
  const baseHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await baseHandle.sync(); } finally { await baseHandle.close(); }
  return { ...publication.root, providerAuthority: false as const, reclaimEligible: false as const };
}
