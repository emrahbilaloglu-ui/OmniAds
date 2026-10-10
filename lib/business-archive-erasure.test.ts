import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { businessArchiveFixture } from "../scripts/fixtures/business-archive-erasure";
import { archiveDigest, resolveBusinessArchiveConfiguration } from "./business-archive-configuration";
import { applyBusinessArchiveErasurePlan, inventoryBusinessArchive, prepareBusinessArchiveErasurePlan,
  type BusinessArchiveErasurePlan } from "./business-archive-erasure";
import { assertNoBusinessNativeArchive } from "./business-deletion-files";
import { buildNativeHistoricalCatalogRouting } from "./creative-decision-engine/native-historical-catalog-routing";
import { readNativeHistoricalAdEvidence } from "./creative-decision-engine/native-historical-archive-reader";
import { readLocalNativeArchiveVersion } from "./creative-decision-engine/native-historical-local-store";
import { verifyNativeHistoricalEvidenceInWorker } from "./creative-decision-engine/native-historical-archive-worker-client";
import type { PoolClient } from "pg";

let base: string, archive: string, control: string;
const business = "00000000-0000-4000-8000-000000000777";
const query = vi.fn(async (sql: string) => sql.startsWith("EXPLAIN") ? { rows: [{ "QUERY PLAN": [{ Plan: {
  "Node Type": "Index Scan", "Index Cond": "((contract_version = $1) AND (input_hash = $2))",
} }] }] } : { rows: [] });
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "archive-auto-erasure-"))); archive = join(base, "archive"); control = join(base, "control");
  await mkdir(archive, { mode: 0o700 }); await mkdir(control, { mode: 0o700 }); query.mockClear();
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT", "filesystem"); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT", archive);
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ACTIVE_POINTER", join(control, "active.json"));
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED", "true");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); });
async function put(path: string, content: Buffer) {
  const { dirname } = await import("node:path"); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: path.endsWith(".bin") ? 0o440 : 0o600 });
}
async function setup(routed = true) {
  const selected = await businessArchiveFixture(business), foreign = await businessArchiveFixture(randomUUID());
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID", selected.keyId);
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX", selected.key.toString("hex"));
  for (const f of [selected, foreign]) await put(join(archive, f.entry.object.key), f.bytes);
  const legacy = Buffer.from(JSON.stringify({ contract: routed ? "native-historical-archive-catalog.v1" : "native-historical-archive-catalog.v2",
    entries: routed ? [] : [selected.entry, foreign.entry] }));
  const path = join(archive, "catalogs", `${archiveDigest(legacy)}.json`); await put(path, legacy);
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH", path); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256", archiveDigest(legacy));
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED", String(routed));
  if (routed) {
    const leaves = [selected, foreign].map(f => { const content = Buffer.from(JSON.stringify({
      contract: "native-historical-archive-catalog.v3", groups: [], entries: [f.entry],
    })); return { content, sha256: archiveDigest(content) }; });
    const publication = buildNativeHistoricalCatalogRouting({ legacy: { content: legacy, sha256: archiveDigest(legacy) }, leaves });
    for (const directory of ["routing-active", "routing-inactive"]) for (const f of publication.files)
      await put(join(archive, directory, f.kind, `${f.sha256}.json`), f.content);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT", join(archive, "routing-active"));
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256", publication.root.sha256);
  }
  const foreignProof = join(archive, "public-proof.json"); await put(foreignProof, Buffer.from('{"shared":"preserve"}'));
  return { selected, foreign, foreignProof };
}
const plan = () => prepareBusinessArchiveErasurePlan(business, { query } as unknown as PoolClient);
const apply = (p: BusinessArchiveErasurePlan) => applyBusinessArchiveErasurePlan(p, Date.now() + 10_000);
describe("automatic archive offboarding saga", () => {
  it.each([false, true])("removes served and inactive selected copies, preserving foreign ciphertext/metadata (routing=%s)", async routed => {
    const f = await setup(routed), before = await inventoryBusinessArchive(archive), p = await plan();
    expect(p.inputKeys).toHaveLength(1); expect(p.inputKeys[0]!.frozenRowSha256).toBeNull();
    await apply(p); await assertNoBusinessNativeArchive(business);
    expect(await readFile(join(archive, f.foreign.entry.object.key))).toEqual(f.foreign.bytes);
    const after = await inventoryBusinessArchive(archive), keep = new Set(p.remove);
    for (const original of before.filter(f => !keep.has(f.path))) expect(after.find(f => f.path === original.path)).toMatchObject({ sha256: original.sha256, bytes: original.bytes });
    expect(after.every(f => !f.content?.includes(business))).toBe(true);
    const template = JSON.parse(await readFile(join(process.cwd(), "scripts/fixtures/native-historical-worker.json"), "utf8"));
    const downloaded = await readLocalNativeArchiveVersion(archive, f.foreign.entry, new AbortController().signal);
    await verifyNativeHistoricalEvidenceInWorker(downloaded, f.foreign.key, f.foreign.entry,
      { ...template.request, generation: f.foreign.generation }, new AbortController().signal);
    const proof = await readNativeHistoricalAdEvidence({ ...template.request, generation: f.foreign.generation });
    expect(proof.status).toBe("historical_available");
    expect(proof).toMatchObject({ providerAuthority: false, currentDecisionEligible: false });
  });
  it("resumes after publication and partial catalog unlink using the durable exact plan", async () => {
    const f = await setup(), p = await plan();
    await expect(applyBusinessArchiveErasurePlan(p, Date.now() + 10_000, async phase => {
      if (phase === "published") throw Error("fixture crash");
    })).rejects.toThrow("fixture crash");
    expect(await resolveBusinessArchiveConfiguration()).toEqual(p.after);
    for (const path of p.remove.filter(p => p.endsWith(".json"))) await unlink(join(archive, path));
    expect((await lstat(join(archive, f.selected.entry.object.key))).isFile()).toBe(true);
    await apply(p); await assertNoBusinessNativeArchive(business);
    await expect(lstat(join(archive, f.selected.entry.object.key))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses changed foreign bytes before publishing or unlinking anything", async () => {
    const f = await setup(), p = await plan(); await writeFile(f.foreignProof, '{"shared":"changed"}');
    await expect(apply(p)).rejects.toThrow();
    expect(await readFile(join(archive, f.selected.entry.object.key))).toEqual(f.selected.bytes);
    await expect(lstat(join(control, "active.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("recovers an exact owned partial metadata write without treating it as foreign absence",async()=>{
    await setup();const p=await plan(),f=p.publication.find(f=>!p.baseline.some(b=>b.path===f.path))!;
    await put(join(archive,f.path)+".writing",Buffer.from(f.contentBase64,"base64").subarray(0,10));
    await apply(p);await assertNoBusinessNativeArchive(business);
    await expect(lstat(join(archive,f.path)+".writing")).rejects.toMatchObject({code:"ENOENT"});
  });
  it("refuses incomplete/orphan object ownership and unsafe symlink paths", async () => {
    const f = await setup(); const bytes = Buffer.from("orphan");
    await put(join(archive, "native/v2", `${archiveDigest(bytes)}.bin`), bytes);
    await expect(plan()).rejects.toThrow();
    await unlink(join(archive, "native/v2", `${archiveDigest(bytes)}.bin`));
    await symlink(f.foreignProof, join(archive, "linked.json")); await expect(plan()).rejects.toThrow();
    expect(await readFile(f.foreignProof, "utf8")).toContain("preserve");
  });
  it("refuses unsupported identifying metadata and a complete-census overflow", async () => {
    const f = await setup(); await put(join(archive, "unsupported.json"), Buffer.from(JSON.stringify({ businessId: business })));
    await expect(plan()).rejects.toThrow(); await unlink(join(archive, "unsupported.json"));
    for (let n = 0; n < 257; n++) await put(join(archive, `extra-${n}.json`), Buffer.from("{}"));
    await expect(plan()).rejects.toThrow(); expect(await readFile(join(archive, f.selected.entry.object.key))).toEqual(f.selected.bytes);
  });
  it("rejects an expired phase deadline without starting a publication", async () => {
    const f = await setup(), p = await plan(); await expect(applyBusinessArchiveErasurePlan(p, Date.now() - 1)).rejects.toThrow();
    expect(await readFile(join(archive, f.selected.entry.object.key))).toEqual(f.selected.bytes);
  });
  it("rejects forged persisted plans and unsafe current-pointer trust", async () => {
    await setup(); const p = await plan(); p.remove.push("public-proof.json"); await expect(apply(p)).rejects.toThrow();
    await writeFile(join(control, "active.json"), '{"contract":"forged"}', { mode: 0o600 });
    await expect(resolveBusinessArchiveConfiguration()).rejects.toThrow();
    await chmod(join(control, "active.json"), 0o666); await expect(resolveBusinessArchiveConfiguration()).rejects.toThrow();
  });
});
