import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { NativeHistoricalArchiveCatalogEntry, NativeHistoricalEvidence,
  NativeHistoricalEvidenceRequest } from "./native-historical-archive";
import { NATIVE_HISTORICAL_READ_BOUNDS } from "./native-historical-read-controls";

type Artifact = { source: string; sha256: string };
let artifact: Promise<Artifact> | undefined;
async function exactFile(name: string, limit: number) {
  const file = await open(join(process.cwd(), ".native-historical-worker", name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o022 || stat.size <= 0 || stat.size > limit) throw new Error("worker artifact invalid");
    const bytes = Buffer.alloc(stat.size + 1);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== stat.size) throw new Error("worker artifact changed"); return bytes.subarray(0, stat.size);
  } finally { await file.close(); }
}
export async function readPackagedNativeHistoricalWorker() {
  if (!artifact) artifact = (async () => {
    const manifest = JSON.parse((await exactFile("manifest.json", 4096)).toString("utf8"));
    const bytes = await exactFile("archive-worker.cjs", 16 * 1024 * 1024);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (manifest.contract !== "native-historical-worker-artifact.v1" || manifest.sha256 !== digest ||
        manifest.bytes !== bytes.length) throw new Error("packaged worker digest differs");
    return { source: bytes.toString("utf8"), sha256: digest };
  })().catch(error => { artifact = undefined; throw error; });
  return artifact;
}
export async function verifyNativeHistoricalEvidenceInWorker(bytes: Buffer, key: Buffer,
  entry: NativeHistoricalArchiveCatalogEntry, request: NativeHistoricalEvidenceRequest,
  signal: AbortSignal): Promise<NativeHistoricalEvidence> {
  if (bytes.length !== entry.ciphertextBytes || bytes.length > NATIVE_HISTORICAL_READ_BOUNDS.maxPlaintextBytes + 128 ||
      entry.plaintextBytes > NATIVE_HISTORICAL_READ_BOUNDS.maxPlaintextBytes || key.length !== 32)
    throw new Error("historical worker input bound");
  const compiled = await readPackagedNativeHistoricalWorker();
  if (signal.aborted) throw new Error("historical worker aborted");
  const payload = Uint8Array.from(bytes), secret = Uint8Array.from(key);
  // Execute the exact verified source bytes, avoiding a second path lookup.
  const worker = new Worker(compiled.source, { eval: true,
    env: { NODE_ENV: "production" }, stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    workerData: { bytes: payload.buffer, key: secret.buffer, entry, request },
    transferList: [payload.buffer, secret.buffer], trackUnmanagedFds: true });
  worker.stdout.on("data", () => {}); worker.stderr.on("data", () => {});
  return await new Promise<NativeHistoricalEvidence>((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error, value?: NativeHistoricalEvidence) => {
      if (finished) return; finished = true; clearTimeout(timer);
      signal.removeEventListener("abort", abort); void worker.terminate();
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new Error("historical worker aborted"));
    const timer = setTimeout(() => finish(new Error("historical worker deadline")), 5000);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", response => {
      if (response?.ok !== true || !response.value) finish(new Error("historical worker verification refused"));
      else finish(undefined, response.value as NativeHistoricalEvidence);
    });
    worker.once("error", () => finish(new Error("historical worker failed")));
    worker.once("exit", () => { if (!finished) finish(new Error("historical worker exited without proof")); });
    if (signal.aborted) abort();
  });
}
