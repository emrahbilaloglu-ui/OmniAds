import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertBusinessExternalDataRemoved, BusinessExternalCleanupError } from "./business-deletion-files";
import { buildNativeHistoricalCatalogRouting } from "./creative-decision-engine/native-historical-catalog-routing";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => query }));
const sha = (content: Buffer) => createHash("sha256").update(content).digest("hex");
let directory: string;
const business = "00000000-0000-4000-8000-000000000999";
const envKeys = ["ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH", "ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256",
  "ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED", "ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED",
  "ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT", "ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256",
  "ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT", "ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT"];
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "business-erasure-fixture-")));
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  for (const key of envKeys) vi.stubEnv(key, "");
  query.mockReset().mockResolvedValue([]);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
async function catalog(target: string, routed = false) {
  const fixture = JSON.parse(await readFile(resolve(import.meta.dirname, "../scripts/fixtures/native-historical-worker.json"), "utf8"));
  const entry = { ...fixture.entry, generation: { ...fixture.entry.generation, businessId: target, jobRunId: randomUUID() } };
  const legacy = Buffer.from(JSON.stringify({ contract: "native-historical-archive-catalog.v1", entries: routed ? [] : [entry] }));
  const archive = join(directory,"archive");await mkdir(archive,{recursive:true});
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT",archive);vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT","filesystem");
  const path = join(archive, "catalog.json"); await writeFile(path, legacy, { mode: 0o600 });
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH", path);vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256", sha(legacy));
  if (routed) {
    const content = Buffer.from(JSON.stringify({ contract:"native-historical-archive-catalog.v3", groups:[], entries:[entry] }));
    const p = buildNativeHistoricalCatalogRouting({ legacy:{content:legacy,sha256:sha(legacy)}, leaves:[{content,sha256:sha(content)}] });
    const root = join(archive, "routing");
    for (const f of p.files) { await mkdir(join(root,f.kind), {recursive:true}); await writeFile(join(root,f.kind,`${f.sha256}.json`), f.content,{mode:0o600}); }
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED", "true");
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT", root);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256",p.root.sha256);
  }
  return path;
}
describe("business-owned external data erasure boundary", () => {
  it("removes only the business media directories and accepts already absent files", async () => {
    const other = randomUUID(), target = join(directory,".cache/media/meta",business), keep = join(directory,".cache/media/meta",other);
    for (const path of [target,keep]) { await mkdir(path,{recursive:true});await writeFile(join(path,"creative.jpg"), "fixture"); }
    query.mockResolvedValue([{storage_key:`meta/${business}/creative.jpg`}]);
    await assertBusinessExternalDataRemoved(business);
    await expect(lstat(target)).rejects.toMatchObject({code:"ENOENT"});
    expect(await readFile(join(keep,"creative.jpg"),"utf8")).toBe("fixture");
    await rm(join(directory,".cache"),{recursive:true});
    await expect(assertBusinessExternalDataRemoved(business)).resolves.toBeUndefined();
  });
  it("refuses foreign storage keys and symlink paths without deleting the destination", async () => {
    const keep = join(directory,"keep");await mkdir(keep);await writeFile(join(keep,"original"),"keep");
    query.mockResolvedValue([{storage_key:`meta/${randomUUID()}/creative.jpg`}]);
    await expect(assertBusinessExternalDataRemoved(business)).rejects.toBeInstanceOf(BusinessExternalCleanupError);
    query.mockResolvedValue([]);await mkdir(join(directory,".cache/media/meta"),{recursive:true});
    await symlink(keep,join(directory,".cache/media/meta",business));
    await expect(assertBusinessExternalDataRemoved(business)).rejects.toBeInstanceOf(BusinessExternalCleanupError);
    expect(await readFile(join(keep,"original"),"utf8")).toBe("keep");
  });
  it.each([false,true])("refuses remaining target archives in pinned metadata (routing=%s)",async routed => {
    await catalog(business,routed);
    await expect(assertBusinessExternalDataRemoved(business)).rejects.toBeInstanceOf(BusinessExternalCleanupError);
    expect(query).not.toHaveBeenCalled();
  });
  it("accepts verified foreign archive generations without changing their pinned files",async () => {
    const path = await catalog(randomUUID(),true), before=await readFile(path);
    await assertBusinessExternalDataRemoved(business);
    expect(await readFile(path)).toEqual(before);
  });
  it("refuses an inactive target catalog and an unowned ciphertext copy",async () => {
    const path=await catalog(randomUUID()), before=await readFile(path);
    const copy=JSON.parse(before.toString());copy.entries[0].generation.businessId=business;
    await writeFile(join(directory,"archive/inactive.json"),JSON.stringify(copy),{mode:0o600});
    await expect(assertBusinessExternalDataRemoved(business)).rejects.toBeInstanceOf(BusinessExternalCleanupError);
    await rm(join(directory,"archive/inactive.json"));await mkdir(join(directory,"archive/native/v2"),{recursive:true});
    await writeFile(join(directory,"archive/native/v2",`${"f".repeat(64)}.bin`),"unknown",{mode:0o400});
    await expect(assertBusinessExternalDataRemoved(business)).rejects.toBeInstanceOf(BusinessExternalCleanupError);
  });
  it("refuses invalid digest, writable metadata and enabled-but-unconfigured archives",async () => {
    const path=await catalog(randomUUID());vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256","a".repeat(64));
    await expect(assertBusinessExternalDataRemoved(business)).rejects.toBeInstanceOf(BusinessExternalCleanupError);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256",sha(await readFile(path)));await chmod(path,0o666);
    await expect(assertBusinessExternalDataRemoved(business)).rejects.toBeInstanceOf(BusinessExternalCleanupError);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH","");vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED","true");
    await expect(assertBusinessExternalDataRemoved(business)).rejects.toBeInstanceOf(BusinessExternalCleanupError);
  });
});
