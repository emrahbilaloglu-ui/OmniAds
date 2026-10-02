import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { nativeArchiveByteDigest, NATIVE_HISTORICAL_CATALOG_CONTRACT, openNativeHistoricalArchiveCatalog,
  type NativeHistoricalArchiveCatalogEntry } from "../native-historical-archive";
import { NATIVE_HISTORICAL_READER_GATE, readNativeHistoricalAdEvidence } from "../native-historical-archive-reader";
import { persistLocalNativeArchive, readLocalNativeArchiveVersion, withLocalNativeArchiveRead } from "../native-historical-local-store";

const fixture = JSON.parse(await readFile(join(process.cwd(), "scripts/fixtures/native-historical-worker.json"), "utf8"));
const bytes = Buffer.from(fixture.ciphertextBase64, "base64");
const roots: string[] = [];
async function root() {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "adsecute-local-archive-")));
  await chmod(folder, 0o700); roots.push(folder); return folder;
}
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const folder of roots.splice(0)) await rm(folder, { recursive: true, force: true }); });

describe("existing-disk immutable historical transport", () => {
  it("persists fsynced ciphertext once, preserves bytes on retry and resolves independently trusted catalog", async () => {
    const folder = await root(), entry = await persistLocalNativeArchive(folder, bytes, fixture.entry);
    const filename = join(folder, entry.object.key), first = await lstat(filename);
    expect(entry.object.versionId).toBe(entry.ciphertextSha256);
    expect(await persistLocalNativeArchive(folder, bytes, fixture.entry)).toEqual(entry);
    expect((await lstat(filename)).ino).toBe(first.ino);
    expect(first.mode & 0o222).toBe(0); expect(first.nlink).toBe(1);
    expect(await readdir(join(folder, "native/v1"))).toEqual([`${entry.ciphertextSha256}.bin`]);
    const catalog = Buffer.from(JSON.stringify({ contract: NATIVE_HISTORICAL_CATALOG_CONTRACT, entries: [entry] }));
    expect(openNativeHistoricalArchiveCatalog(catalog, nativeArchiveByteDigest(catalog)).entries).toEqual([entry]);
    expect(await readLocalNativeArchiveVersion(folder, entry)).toEqual(bytes);
  });
  it("runs the actual bounded runtime and separate compiled validator without any S3 credential or call", async () => {
    const folder = await root(), entry = await persistLocalNativeArchive(folder, bytes, fixture.entry);
    const catalog = Buffer.from(JSON.stringify({ contract: NATIVE_HISTORICAL_CATALOG_CONTRACT, entries: [entry] }));
    const filename = join(folder, "catalog.json"); await writeFile(filename, catalog, { mode: 0o600 });
    vi.stubEnv(NATIVE_HISTORICAL_READER_GATE, "true");
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT", "filesystem"); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT", folder);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH", filename);vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256", nativeArchiveByteDigest(catalog));
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID", entry.encryptionKeyId);vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX", fixture.fixtureEncryptionKeyHex);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_S3_ACCESS_KEY_ID", "");vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_S3_SECRET_ACCESS_KEY", "");
    const send = vi.spyOn(S3Client.prototype, "send");
    expect(await readNativeHistoricalAdEvidence(fixture.request)).toEqual(fixture.expectedEvidence);
    const foreign = structuredClone(fixture.request); foreign.generation.businessId = "00000000-0000-4000-8000-000000000999";
    expect(await readNativeHistoricalAdEvidence(foreign)).toEqual({ status: "unavailable", reason: "native_historical_archive_unavailable" });
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["bucket", "key", "version"])("refuses a foreign %s pointer instead of reading an alternate object", async fault => {
    const folder = await root(), entry = await persistLocalNativeArchive(folder, bytes, fixture.entry);
    const changed = structuredClone(entry);
    if (fault === "bucket") changed.object.bucket = "foreign-bucket";
    if (fault === "key") changed.object.key = "../outside";
    if (fault === "version") changed.object.versionId = "latest";
    await expect(readLocalNativeArchiveVersion(folder, changed)).rejects.toThrow("pointer");
  });
  it.each(["symlink", "hardlink", "writable", "directory", "truncated", "oversized", "digest"])("refuses object fault %s", async fault => {
    const folder = await root(), entry = await persistLocalNativeArchive(folder, bytes, fixture.entry), filename = join(folder, entry.object.key);
    if (fault === "symlink") { await rm(filename); await writeFile(join(folder, "other"), bytes); await symlink(join(folder, "other"), filename); }
    if (fault === "hardlink") await link(filename, join(folder, "other"));
    if (fault === "writable") await chmod(filename, 0o640);
    if (fault === "directory") { await rm(filename); await mkdir(filename); }
    if (["truncated", "oversized", "digest"].includes(fault)) {
      await chmod(filename, 0o600);
      const changed = fault === "truncated" ? bytes.subarray(0, bytes.length - 1) : fault === "oversized" ? Buffer.concat([bytes, Buffer.from([0])]) : Buffer.from(bytes);
      if (fault === "digest") changed[33] ^= 1;
      await writeFile(filename, changed); await chmod(filename, 0o440);
    }
    await expect(readLocalNativeArchiveVersion(folder, entry)).rejects.toThrow();
  });
  it.each(["root-writable", "parent-symlink", "parent-writable"])("refuses unsafe deployment directory %s", async fault => {
    const folder = await root(), entry = await persistLocalNativeArchive(folder, bytes, fixture.entry);
    if (fault === "root-writable") await chmod(folder, 0o777);
    if (fault === "parent-writable") await chmod(join(folder, "native"), 0o770);
    if (fault === "parent-symlink") {
      const other = await root(); await rm(join(folder, "native"), { recursive: true });
      await symlink(other, join(folder, "native"));
    }
    await expect(readLocalNativeArchiveVersion(folder, entry)).rejects.toThrow("directory");
  });
  it("never replaces a corrupted existing object or leaves its own retry temporary file", async () => {
    const folder = await root(), entry = await persistLocalNativeArchive(folder, bytes, fixture.entry), filename = join(folder, entry.object.key);
    await chmod(filename, 0o600); const bad = Buffer.alloc(bytes.length); await writeFile(filename, bad); await chmod(filename, 0o440);
    await expect(persistLocalNativeArchive(folder, bytes, fixture.entry)).rejects.toThrow("digest");
    expect(await readFile(filename)).toEqual(bad);
    expect(await readdir(join(folder, "native/v1"))).toEqual([`${entry.ciphertextSha256}.bin`]);
  });
  it("rejects mismatched publication bytes and pre-aborted reads without a fallback", async () => {
    const folder = await root();
    await expect(persistLocalNativeArchive(folder, Buffer.alloc(bytes.length), fixture.entry)).rejects.toThrow("trust");
    expect(await readdir(folder)).toEqual([]);
    const entry = await persistLocalNativeArchive(folder, bytes, fixture.entry), abort = new AbortController(); abort.abort();
    await expect(readLocalNativeArchiveVersion(folder, entry, abort.signal)).rejects.toThrow("aborted");
  });
  it("holds its real I/O slot after timeout, rejects further fs work and closes a late descriptor before reuse", async () => {
    const folder = await root(), entry = await persistLocalNativeArchive(folder, bytes, fixture.entry);
    const file = await open(join(folder, entry.object.key), "r");
    vi.useFakeTimers();
    let release!: () => void, drained!: () => void;
    const lag = new Promise<void>(resolve => { release = resolve; });
    const closed = new Promise<void>(resolve => { drained = resolve; });
    const pending = withLocalNativeArchiveRead(async () => {
      try { await lag; return bytes; }
      finally { await file.close(); drained(); }
    });
    const rejection = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5000); await rejection;
    const otherFsOperation = vi.fn(async () => Buffer.alloc(1));
    await expect(withLocalNativeArchiveRead(otherFsOperation)).rejects.toThrow("outstanding");
    expect(otherFsOperation).not.toHaveBeenCalled();
    await expect(readLocalNativeArchiveVersion("/does-not-exist", entry)).rejects.toThrow("outstanding");
    release(); await closed; await vi.advanceTimersByTimeAsync(0);
    await expect(file.stat()).rejects.toThrow();
    vi.useRealTimers();
    expect(await readLocalNativeArchiveVersion(folder, entry)).toEqual(bytes);
  });
  it("refuses a missing or unsupported explicit transport without using S3 defaults", async () => {
    vi.stubEnv(NATIVE_HISTORICAL_READER_GATE, "true");vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT", "filesystem");
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT", "");
    const send = vi.spyOn(S3Client.prototype, "send");
    expect(await readNativeHistoricalAdEvidence(fixture.request)).toMatchObject({ status: "unavailable" });
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT", "automatic");
    expect(await readNativeHistoricalAdEvidence(fixture.request)).toMatchObject({ status: "unavailable" });
    expect(send).not.toHaveBeenCalled();
  });
});
