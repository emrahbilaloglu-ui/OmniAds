import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NativeHistoricalReadControls, NativeHistoricalReadLimit } from "./native-historical-read-controls";
import { readPackagedNativeHistoricalWorker, verifyNativeHistoricalEvidenceInWorker } from "./native-historical-archive-worker-client";
import { readLocalNativeArchiveVersion, withLocalNativeArchiveRead } from "./native-historical-local-store";
import {
  NATIVE_HISTORICAL_MAX_CATALOG_BYTES,
  NATIVE_HISTORICAL_MAX_PLAINTEXT_BYTES,
  openNativeHistoricalArchiveCatalog,
  resolveNativeHistoricalArchiveEntry,
  type NativeHistoricalArchiveCatalogEntry,
  type NativeHistoricalEvidence,
  type NativeHistoricalEvidenceRequest,
} from "./native-historical-archive";

const READ_TIMEOUT_MS = 5000;
export const NATIVE_HISTORICAL_READER_GATE = "ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED";
export type NativeHistoricalEvidenceReadResult = NativeHistoricalEvidence |
  { status: "disabled"; reason: "native_historical_reader_disabled" } |
  { status: "limited"; reason: "native_historical_reader_limit_reached" } |
  { status: "unavailable"; reason: "native_historical_archive_unavailable" };
const controls = new NativeHistoricalReadControls(undefined, (event, cost) => {
  console.info("[native-historical-reader]", { event, durationMs: Math.round(cost.durationMs), bytes: cost.bytes });
});

/** One versioned GET, no List/Head/write commands, no fallback to a newer version.
 * Caller configures maxAttempts=1 and explicit archive-only credentials. */
export async function downloadNativeArchiveVersion(client: Pick<S3Client, "send">, entry: NativeHistoricalArchiveCatalogEntry,
  externalSignal?: AbortSignal): Promise<Buffer> {
  if (externalSignal?.aborted) throw new Error("Historical object aborted");
  if (!Number.isSafeInteger(entry.ciphertextBytes) || entry.ciphertextBytes <= 0 ||
    entry.ciphertextBytes > NATIVE_HISTORICAL_MAX_PLAINTEXT_BYTES + 128 || !entry.object.versionId || entry.object.versionId === "null")
    throw new Error("Historical object bound/version missing");
  const controller = new AbortController();
  let stream: Readable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let externalAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); stream?.destroy(); reject(new Error("Historical object deadline exceeded")); }, READ_TIMEOUT_MS);
    externalAbort = () => { controller.abort(); stream?.destroy(); reject(new Error("Historical object aborted")); };
    externalSignal?.addEventListener("abort", externalAbort, { once: true });
    if (externalSignal?.aborted) externalAbort();
  });
  const download = async () => {
    const response = await client.send(new GetObjectCommand({ Bucket: entry.object.bucket,
      Key: entry.object.key, VersionId: entry.object.versionId }), { abortSignal: controller.signal });
    if (!(response.Body instanceof Readable)) throw new Error("Historical object stream absent");
    stream = response.Body;
    // A transport that ignores abort may resolve after the outer deadline/finally.
    // Destroy its late body immediately instead of waiting for a first chunk.
    if (controller.signal.aborted) { stream.destroy();throw new Error("Historical object aborted"); }
    if (response.VersionId !== entry.object.versionId || response.ContentLength !== entry.ciphertextBytes ||
      response.ContentEncoding && response.ContentEncoding !== "identity") throw new Error("Historical object version/size differs");
    const chunks: Buffer[] = [];
    let count = 0;
    for await (const chunk of stream) {
      if (controller.signal.aborted) throw new Error("Historical object aborted");
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      count += bytes.length;
      if (count > entry.ciphertextBytes) throw new Error("Historical object exceeds trusted bound");
      chunks.push(bytes);
    }
    if (count !== entry.ciphertextBytes) throw new Error("Historical object truncated");
    return Buffer.concat(chunks, count);
  };
  try { return await Promise.race([download(), deadline]); }
  finally { if (timer) clearTimeout(timer); if (externalAbort) externalSignal?.removeEventListener("abort", externalAbort);
    controller.abort(); stream?.destroy(); }
}

async function readTrustedLocalCatalog(filename: string, signal: AbortSignal): Promise<Buffer> {
  // The path is deployment configuration, never a request parameter. Final symlinks
  // and writable-by-group/other catalogs are refused; the independent digest also binds bytes.
  if (!filename.startsWith("/")) throw new Error("Catalog path must be absolute");
  if (signal.aborted) throw new Error("Catalog read aborted");
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (signal.aborted) throw new Error("Catalog read aborted");
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.size <= 0 || stat.size > NATIVE_HISTORICAL_MAX_CATALOG_BYTES)
      throw new Error("Invalid catalog file");
    const bytes = Buffer.alloc(NATIVE_HISTORICAL_MAX_CATALOG_BYTES + 1);
    if (signal.aborted) throw new Error("Catalog read aborted");
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (signal.aborted || bytesRead !== stat.size || bytesRead > NATIVE_HISTORICAL_MAX_CATALOG_BYTES) throw new Error("Catalog changed or exceeds bound");
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

/** Actual runtime adapter, default OFF. Configuration/credential failures return
 * unavailable; they never fall back to current evidence or advance any pointer. */
export async function readNativeHistoricalAdEvidence(request: NativeHistoricalEvidenceRequest): Promise<NativeHistoricalEvidenceReadResult> {
  if (process.env[NATIVE_HISTORICAL_READER_GATE] !== "true") return { status: "disabled", reason: "native_historical_reader_disabled" };
  try {
    return await controls.read(request, async () => {
      const filename = process.env.ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH;
      const catalogDigest = process.env.ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256;
      const keyId = process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID;
      const keyHex = process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX;
      const accessKeyId = process.env.ENGINE_V3_NATIVE_ARCHIVE_S3_ACCESS_KEY_ID;
      const secretAccessKey = process.env.ENGINE_V3_NATIVE_ARCHIVE_S3_SECRET_ACCESS_KEY;
      const transport = process.env.ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT ?? "s3";
      const localRoot = process.env.ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT;
      if (!filename || !catalogDigest || !keyId || !keyHex || !/^[0-9a-f]{64}$/.test(keyHex) ||
          transport !== "s3" && transport !== "filesystem" ||
          transport === "s3" && (!accessKeyId || !secretAccessKey) || transport === "filesystem" && !localRoot)
        throw new Error("Explicit archive configuration absent");
      const catalog = openNativeHistoricalArchiveCatalog(await withLocalNativeArchiveRead(signal => readTrustedLocalCatalog(filename, signal)), catalogDigest);
      const entry = resolveNativeHistoricalArchiveEntry(catalog, request);
      if (entry.encryptionKeyId !== keyId) throw new Error("Archive encryption key unavailable");
      const packaged = await readPackagedNativeHistoricalWorker();
      // A changed catalog, key, credential policy or compiled validator cannot inherit a cache.
      const configurationFingerprint = createHash("sha256").update(JSON.stringify([
        catalogDigest, keyId, keyHex, transport, localRoot, accessKeyId, secretAccessKey, packaged.sha256,
      ])).digest("hex");
      return { configurationFingerprint, entry, work: {
        download: async (object, signal) => {
          if (transport === "filesystem") return readLocalNativeArchiveVersion(localRoot!, object, signal);
          // Lazy allocation after admission; no implicit credential chain or write commands.
          const client = new S3Client({ region: "fsn1", endpoint: "https://fsn1.your-objectstorage.com", forcePathStyle: true,
            credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! }, maxAttempts: 1 });
          try { return await downloadNativeArchiveVersion(client, object, signal); }
          finally { client.destroy(); }
        },
        validate: (bytes, object, original, signal) =>
          verifyNativeHistoricalEvidenceInWorker(bytes, Buffer.from(keyHex, "hex"), object, original, signal),
      } };
    });
  } catch (error) {
    if (error instanceof NativeHistoricalReadLimit) return { status: "limited", reason: "native_historical_reader_limit_reached" };
    // Do not expose provider URLs, key IDs, file paths, credentials or row bytes in error responses.
    return { status: "unavailable", reason: "native_historical_archive_unavailable" };
  }
}
