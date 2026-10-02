import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { nativeArchiveByteDigest, NATIVE_HISTORICAL_MAX_PLAINTEXT_BYTES,
  type NativeHistoricalArchiveContentTrust, type NativeHistoricalArchiveCatalogEntry } from "./native-historical-archive";

export const NATIVE_LOCAL_ARCHIVE_BUCKET = "adsecute-native-local";
const READ_TIMEOUT_MS = 5000;
const MAX_BYTES = NATIVE_HISTORICAL_MAX_PLAINTEXT_BYTES + 128;
let pendingLocalReads = 0;

function refuse(reason: string): never { throw new Error(`Local historical archive refused: ${reason}`); }
function checkTrust(trust: NativeHistoricalArchiveContentTrust) {
  if (!/^[a-f0-9]{64}$/.test(trust.ciphertextSha256) || !Number.isSafeInteger(trust.ciphertextBytes) ||
      trust.ciphertextBytes <= 0 || trust.ciphertextBytes > MAX_BYTES) refuse("invalid trusted object bound");
}
function pointer(trust: NativeHistoricalArchiveContentTrust) {
  checkTrust(trust);
  return { bucket: NATIVE_LOCAL_ARCHIVE_BUCKET, key: `native/v1/${trust.ciphertextSha256}.bin`, versionId: trust.ciphertextSha256 };
}

/** Deployment-selected root only. Each object directory must be owned by the
 * same administrator and neither group nor other writable. The application
 * additionally mounts this root read-only; this is not root-proof Object Lock. */
async function directory(root: string) {
  if (!isAbsolute(root) || resolve(root) !== root || root === "/" || await realpath(root) !== root)
    refuse("noncanonical archive root");
  let owner: number | undefined;
  for (const filename of [root, join(root, "native"), join(root, "native/v1")]) {
    const stat = await lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
        owner !== undefined && stat.uid !== owner) refuse("unsafe object directory");
    owner = stat.uid;
  }
  return { filename: join(root, "native/v1"), owner: owner! };
}
function aborted(signal: AbortSignal) { if (signal.aborted) refuse("read aborted"); }

/** ONE genuinely outstanding local read, including catalog metadata I/O. An
 * outer deadline cannot release this slot: only the underlying operation's
 * finally, after its descriptor closes, can do so. No queue and no fs access
 * when the slot is occupied. This bounds stalled libuv disk work separately
 * from the request/validation counters whose deadlines can finish earlier. */
export async function withLocalNativeArchiveRead<T>(operation: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal): Promise<T> {
  if (externalSignal?.aborted) refuse("read aborted");
  if (pendingLocalReads >= 1) refuse("local read still outstanding");
  pendingLocalReads++;
  const controller = new AbortController();
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const cancel = () => { controller.abort(); rejectDeadline(new Error("Local historical archive read aborted")); };
  const timer = setTimeout(cancel, READ_TIMEOUT_MS);
  externalSignal?.addEventListener("abort", cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  const read = Promise.resolve().then(() => { aborted(controller.signal); return operation(controller.signal); })
    .finally(() => { pendingLocalReads--; });
  try { return await Promise.race([read, deadline]); }
  finally { clearTimeout(timer); externalSignal?.removeEventListener("abort", cancel); controller.abort(); }
}

/** Content-addressed exact-version read; no S3 fallback, caller-selected paths,
 * writes, directory listing or latest-version lookup. Late I/O still closes its
 * descriptor after cancellation; the deadline does not cancel kernel disk I/O. */
export async function readLocalNativeArchiveVersion(root: string, entry: NativeHistoricalArchiveCatalogEntry,
  externalSignal?: AbortSignal): Promise<Buffer> {
  const expected = pointer(entry);
  if (entry.object.bucket !== expected.bucket || entry.object.key !== expected.key || entry.object.versionId !== expected.versionId)
    refuse("local object pointer differs");
  return withLocalNativeArchiveRead(async signal => {
    aborted(signal);
    const dir = await directory(root); aborted(signal);
    const filename = join(dir.filename, `${entry.ciphertextSha256}.bin`);
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      aborted(signal);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== dir.owner || (stat.mode & 0o222) !== 0 ||
          stat.size !== entry.ciphertextBytes) refuse("unsafe or changed object");
      const bytes = Buffer.alloc(entry.ciphertextBytes + 1);
      let count = 0;
      while (count < bytes.length) {
        aborted(signal);
        const part = await file.read(bytes, count, Math.min(64 * 1024, bytes.length - count), count);
        if (!part.bytesRead) break;
        count += part.bytesRead;
      }
      aborted(signal);
      const end = await file.stat(), named = await lstat(filename), endDir = await directory(root);
      if (count !== entry.ciphertextBytes || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs ||
          end.ctimeMs !== stat.ctimeMs || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino ||
          endDir.owner !== dir.owner || nativeArchiveByteDigest(bytes.subarray(0, count)) !== entry.ciphertextSha256)
        refuse("object identity or digest changed");
      return bytes.subarray(0, count);
    } finally { await file.close(); }
  }, externalSignal);
}

/** OFFLINE operator writer. Caller first validates/seals the complete original
 * bundle. Only its new temporary file is ever removed. Hard-link publication
 * refuses replacement, fsyncs the bytes and directory, and verifies an existing
 * exact object on retry. It never publishes a catalog, edits DB rows or grants
 * reclaim/provider authority. Source root/key recovery remains a separate gate. */
export async function persistLocalNativeArchive(root: string, bytes: Uint8Array,
  trust: NativeHistoricalArchiveContentTrust): Promise<NativeHistoricalArchiveCatalogEntry> {
  const object = pointer(trust);
  if (bytes.byteLength !== trust.ciphertextBytes || nativeArchiveByteDigest(bytes) !== trust.ciphertextSha256)
    refuse("ciphertext does not match independent trust");
  await directoryRoot(root);
  await mkdir(join(root, "native"), { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await syncDirectory(root);
  await mkdir(join(root, "native/v1"), { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const dir = await directory(root); await syncDirectory(join(root, "native"));
  const target = join(dir.filename, `${trust.ciphertextSha256}.bin`);
  const temporary = join(dir.filename, `.pending-${randomUUID()}`);
  const entry = { ...trust, object };
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(bytes); await file.chmod(0o440); await file.sync(); }
    finally { await file.close(); }
    try { await link(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(temporary); }
  await syncDirectory(dir.filename);
  await readLocalNativeArchiveVersion(root, entry);
  return entry;
}
async function directoryRoot(root: string) {
  if (!isAbsolute(root) || resolve(root) !== root || root === "/" || await realpath(root) !== root) refuse("noncanonical archive root");
  const stat = await lstat(root);
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()) refuse("unsafe writer root");
}
async function syncDirectory(filename: string) {
  const file = await open(filename, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
