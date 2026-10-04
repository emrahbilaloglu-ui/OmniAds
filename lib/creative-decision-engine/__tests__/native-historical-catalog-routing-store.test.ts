import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { nativeArchiveByteDigest, NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT } from "../native-historical-archive";
import { NATIVE_HISTORICAL_READER_GATE, readNativeHistoricalAdEvidence } from "../native-historical-archive-reader";
import { buildNativeHistoricalCatalogRouting, NATIVE_HISTORICAL_ROUTING_BOUNDS as bounds, NATIVE_HISTORICAL_ROUTING_GATE,
  type NativeHistoricalMetadataKind, type NativeHistoricalRoutingFile } from "../native-historical-catalog-routing";
import { persistLocalNativeHistoricalRouting, readLocalNativeHistoricalMetadata } from "../native-historical-catalog-routing-store";
import { persistLocalNativeArchive, withLocalNativeArchiveRead } from "../native-historical-local-store";

const fixture = JSON.parse(await readFile(join(process.cwd(), "scripts/fixtures/native-historical-worker-reference.json"), "utf8"));
const blob = Buffer.from(fixture.ciphertextBase64, "base64"), roots: string[] = [];
const pinned = (content: Buffer) => ({ content, sha256: nativeArchiveByteDigest(content) });
const empty = pinned(Buffer.from(JSON.stringify({ contract: "native-historical-archive-catalog.v2", entries: [] })));
async function ownedRoot() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "adsecute-owned-routing-"))); await chmod(path, 0o700); roots.push(path); return path;
}
function publication(entry = fixture.entry) {
  return buildNativeHistoricalCatalogRouting({ legacy: empty, leaves: [pinned(Buffer.from(JSON.stringify({
    contract: NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT, entries: [entry], groups: [],
  })))] });
}
const cap = (kind: NativeHistoricalMetadataKind) => ({ root: bounds.rootBytes, legacy: bounds.legacyBytes, shard: bounds.shardBytes, leaf: bounds.leafBytes })[kind];
const ref = (f: NativeHistoricalRoutingFile) => ({ kind: f.kind, sha256: f.sha256, bytes: f.bytes, maxBytes: cap(f.kind) });
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("canonical filesystem catalog metadata", () => {
  it("publishes every exact immutable file once and preserves inode/bytes on retry", async () => {
    const folder = await ownedRoot(), p = publication();
    expect(await persistLocalNativeHistoricalRouting(folder, p)).toMatchObject({ ...p.root, providerAuthority: false, reclaimEligible: false });
    const first = await lstat(join(folder, "root", `${p.root.sha256}.json`));
    await persistLocalNativeHistoricalRouting(folder, p);
    expect((await lstat(join(folder, "root", `${p.root.sha256}.json`))).ino).toBe(first.ino);
    for (const f of p.files) {
      const filename = join(folder, f.kind, `${f.sha256}.json`), stat = await lstat(filename);
      expect(stat.nlink).toBe(1); expect(stat.mode & 0o222).toBe(0);
      expect(await readLocalNativeHistoricalMetadata(folder, ref(f))).toEqual(f.content);
      expect((await readdir(join(folder, f.kind))).some(n => n.startsWith(".pending-"))).toBe(false);
    }
  });
  it.each(["symlink", "hardlink", "writable", "directory", "truncated", "oversized", "digest"])("refuses a metadata %s fault", async fault => {
    const folder = await ownedRoot(), p = publication(); await persistLocalNativeHistoricalRouting(folder, p);
    const f = p.files.find(f => f.kind === "leaf")!, filename = join(folder, f.kind, `${f.sha256}.json`);
    if (fault === "symlink") { await rm(filename); await writeFile(join(folder, "alternate"), f.content); await symlink(join(folder, "alternate"), filename); }
    if (fault === "hardlink") await link(filename, join(folder, "alternate"));
    if (fault === "writable") await chmod(filename, 0o660);
    if (fault === "directory") { await rm(filename); await mkdir(filename); }
    if (["truncated", "oversized", "digest"].includes(fault)) {
      const changed = fault === "truncated" ? f.content.subarray(0, f.content.length - 1) : fault === "oversized" ?
        Buffer.concat([f.content, Buffer.alloc(1)]) : Buffer.from(f.content);
      if (fault === "digest") changed[20] ^= 1;
      await chmod(filename, 0o600); await writeFile(filename, changed); await chmod(filename, 0o440);
    }
    await expect(readLocalNativeHistoricalMetadata(folder, ref(f))).rejects.toThrow();
  });
  it.each(["root-writable", "parent-writable", "parent-symlink", "noncanonical-root"])("refuses %s before metadata bytes", async fault => {
    const folder = await ownedRoot(), p = publication(); await persistLocalNativeHistoricalRouting(folder, p);
    const f = p.files.find(f => f.kind === "leaf")!;
    if (fault === "root-writable") await chmod(folder, 0o770);
    if (fault === "parent-writable") await chmod(join(folder, "leaf"), 0o770);
    if (fault === "parent-symlink") { await rm(join(folder, "leaf"), { recursive: true }); await symlink(await ownedRoot(), join(folder, "leaf")); }
    await expect(readLocalNativeHistoricalMetadata(fault === "noncanonical-root" ? folder + "/." : folder, ref(f))).rejects.toThrow();
  });
  it("rejects unknown names/cap lifts and never replaces corrupt existing metadata", async () => {
    const folder = await ownedRoot(), p = publication(); await persistLocalNativeHistoricalRouting(folder, p);
    const f = p.files.find(f => f.kind === "leaf")!, filename = join(folder, "leaf", `${f.sha256}.json`);
    await expect(readLocalNativeHistoricalMetadata(folder, { ...ref(f), sha256: "../outside" })).rejects.toThrow();
    await expect(readLocalNativeHistoricalMetadata(folder, { ...ref(f), maxBytes: bounds.leafBytes + 1 })).rejects.toThrow();
    await chmod(filename, 0o600); const changed = Buffer.alloc(f.content.length); await writeFile(filename, changed); await chmod(filename, 0o440);
    await expect(persistLocalNativeHistoricalRouting(folder, p)).rejects.toThrow();
    expect(await readFile(filename)).toEqual(changed);
    expect(await readdir(join(folder, "leaf"))).toEqual([`${f.sha256}.json`]);
  });
  it("shares the outstanding I/O fence with evidence and keeps it until a timed-out descriptor closes", async () => {
    const folder = await ownedRoot(), p = publication(); await persistLocalNativeHistoricalRouting(folder, p);
    const f = p.files.find(f => f.kind === "leaf")!, handle = await open(join(folder, "leaf", `${f.sha256}.json`), "r");
    let release!: () => void, drained!: () => void;
    const lag = new Promise<void>(resolve => { release = resolve; }), closed = new Promise<void>(resolve => { drained = resolve; });
    vi.useFakeTimers();
    const outstanding = withLocalNativeArchiveRead(async () => { try { await lag; return f.content; }
      finally { await handle.close(); drained(); } });
    const reject = expect(outstanding).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(5000); await reject;
    await expect(readLocalNativeHistoricalMetadata(folder, ref(f))).rejects.toThrow(/outstanding/);
    release(); await closed; await vi.advanceTimersByTimeAsync(0); vi.useRealTimers();
    await expect(handle.stat()).rejects.toThrow();
    expect(await readLocalNativeHistoricalMetadata(folder, ref(f))).toEqual(f.content);
  });
});

describe("actual historical runtime routing adapter", () => {
  it("routes one original encrypted public reference through the actual worker with all authority false", async () => {
    const folder = await ownedRoot(), entry = await persistLocalNativeArchive(folder, blob, fixture.entry), p = publication(entry);
    await persistLocalNativeHistoricalRouting(folder, p);
    const legacyPath = join(folder, "original-legacy.json"); await writeFile(legacyPath, empty.content, { mode: 0o600 });
    vi.stubEnv(NATIVE_HISTORICAL_READER_GATE, "true"); vi.stubEnv(NATIVE_HISTORICAL_ROUTING_GATE, "true");
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT", "filesystem"); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT", folder);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH", legacyPath); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256", empty.sha256);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT", folder); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256", p.root.sha256);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID", entry.encryptionKeyId);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX", fixture.fixtureEncryptionKeyHex);
    const send = vi.spyOn(S3Client.prototype, "send");
    expect(await readNativeHistoricalAdEvidence(fixture.request)).toEqual(fixture.expectedEvidence);
    expect(await readNativeHistoricalAdEvidence(fixture.request)).toEqual(fixture.expectedEvidence);
    const foreign = { ...fixture.request, generation: { ...fixture.request.generation, businessId: "00000000-0000-4000-8000-000000000999" } };
    expect(await readNativeHistoricalAdEvidence(foreign)).toEqual({ status: "unavailable", reason: "native_historical_archive_unavailable" });
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256", "f".repeat(64));
    expect(await readNativeHistoricalAdEvidence(fixture.request)).toMatchObject({ status: "unavailable" });
    expect(send).not.toHaveBeenCalled();
  });
  it("defaults routing OFF and retains the original exact v2 path despite unusable routing configuration", async () => {
    const folder = await ownedRoot(), entry = await persistLocalNativeArchive(folder, blob, fixture.entry);
    const catalog = pinned(Buffer.from(JSON.stringify({ contract: "native-historical-archive-catalog.v2", entries: [entry] })));
    const filename = join(folder, "old-v2.json"); await writeFile(filename, catalog.content, { mode: 0o600 });
    vi.stubEnv(NATIVE_HISTORICAL_READER_GATE, "true"); vi.stubEnv(NATIVE_HISTORICAL_ROUTING_GATE, "");
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT", "filesystem"); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT", folder);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH", filename); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256", catalog.sha256);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT", "/unavailable"); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256", "invalid");
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID", entry.encryptionKeyId);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX", fixture.fixtureEncryptionKeyHex);
    expect(await readNativeHistoricalAdEvidence(fixture.request)).toEqual(fixture.expectedEvidence);
  });
});
