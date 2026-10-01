import { createServer } from "node:http";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadNativeArchiveVersion, NATIVE_HISTORICAL_READER_GATE, readNativeHistoricalAdEvidence } from "../native-historical-archive-reader";
import type { NativeHistoricalArchiveCatalogEntry } from "../native-historical-archive";

const entry: NativeHistoricalArchiveCatalogEntry = {
  generation: { businessId: "00000000-0000-4000-8000-000000000001", jobRunId: "00000000-0000-4000-8000-000000000002",
    asOfDate: "2026-09-30", engineVersion: "fixture" },
  parentManifestHash: "a".repeat(64), parentSchemaHash: "b".repeat(64), encryptionKeyId: "fixture",
  plaintextSha256: "c".repeat(64), plaintextBytes: 3, ciphertextSha256: "d".repeat(64), ciphertextBytes: 51,
  object: { bucket: "fixture-bucket", key: `native/v1/${"d".repeat(64)}.bin`, versionId: "exact+version/1" },
};
const request = { generation: entry.generation, providerAccountId: "act_1", adId: "ad", evaluationId: "evaluation" };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("historical runtime transport boundary", () => {
  it("is default off and does not invoke S3 or silently use current evidence", async () => {
    vi.stubEnv(NATIVE_HISTORICAL_READER_GATE, "");
    const send = vi.spyOn(S3Client.prototype, "send");
    expect(await readNativeHistoricalAdEvidence(request)).toEqual({ status: "disabled", reason: "native_historical_reader_disabled" });
    expect(send).not.toHaveBeenCalled();
  });
  it("refuses missing explicit credentials/configuration before invoking S3", async () => {
    vi.stubEnv(NATIVE_HISTORICAL_READER_GATE, "true");vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH", "");
    const send = vi.spyOn(S3Client.prototype, "send");
    expect(await readNativeHistoricalAdEvidence(request)).toEqual({ status: "unavailable", reason: "native_historical_archive_unavailable" });
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["version", "length", "truncated", "oversize", "encoding", "missing-stream"])("refuses versioned GET fault %s", async fault => {
    const body = Readable.from([Buffer.alloc(fault === "truncated" ? 50 : fault === "oversize" ? 52 : 51)]);
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ VersionId: fault === "version" ? "newer-version" : entry.object.versionId,
      ContentLength: fault === "length" ? 52 : 51, ContentEncoding: fault === "encoding" ? "gzip" : undefined,
      Body: fault === "missing-stream" ? undefined : body } as never);
    const client = new S3Client({ region: "fsn1", credentials: { accessKeyId: "fixture-only", secretAccessKey: "fixture-only" }, maxAttempts: 1 });
    try { await expect(downloadNativeArchiveVersion(client, entry)).rejects.toThrow(); expect(send).toHaveBeenCalledTimes(1); }
    finally { client.destroy();body.destroy(); }
  });
  it("signs ONE actual loopback S3 GET for the exact version and preserves object bytes", async () => {
    const bytes = Buffer.alloc(51, 0x7a), requests: { method?: string; url?: string; signed: boolean }[] = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, signed: req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ") ?? false });
      res.writeHead(200, { "Content-Length": bytes.length, "x-amz-version-id": entry.object.versionId });res.end(bytes);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();if (!address || typeof address === "string") throw new Error("Loopback fixture missing");
    const client = new S3Client({ region: "fsn1", endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true, maxAttempts: 1,
      credentials: { accessKeyId: "loopback-fixture-only", secretAccessKey: "loopback-fixture-only" } });
    try {
      expect(await downloadNativeArchiveVersion(client, entry)).toEqual(bytes);
      expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({ method: "GET", signed: true });
      const url = new URL(requests[0]!.url!, "http://127.0.0.1");
      expect(url.pathname).toBe(`/${entry.object.bucket}/${entry.object.key}`);expect(url.searchParams.get("versionId")).toBe(entry.object.versionId);
    } finally { client.destroy();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("cancels a stalled response body at the same five-second total GET deadline", async () => {
    const body = new Readable({ read() { /* Deliberately no completion. */ } });
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ VersionId: entry.object.versionId, ContentLength: entry.ciphertextBytes, Body: body } as never);
    const client = new S3Client({ region: "fsn1", credentials: { accessKeyId: "fixture-only", secretAccessKey: "fixture-only" }, maxAttempts: 1 });
    const start = Date.now();
    try {
      await expect(downloadNativeArchiveVersion(client, entry)).rejects.toThrow(/deadline/);
      expect(Date.now() - start).toBeGreaterThanOrEqual(4900);expect(body.destroyed).toBe(true);expect(send).toHaveBeenCalledTimes(1);
    } finally { body.destroy();client.destroy(); }
  }, 8000);
  it("destroys a late response body even if the client ignored the deadline abort", async () => {
    vi.useFakeTimers();
    const body = new Readable({ read() { /* A late stalled body must never stay open. */ } });
    let finishSend!: (value: unknown) => void;
    let signal: AbortSignal | undefined;
    const send = vi.fn((_command: unknown, options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return new Promise(resolve => { finishSend = resolve; });
    });
    const result = downloadNativeArchiveVersion({ send } as unknown as Pick<S3Client, "send">, entry);
    const rejected = expect(result).rejects.toThrow(/deadline/);
    try {
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(signal?.aborted).toBe(true);
      finishSend({ VersionId: entry.object.versionId, ContentLength: entry.ciphertextBytes, Body: body });
      await vi.advanceTimersByTimeAsync(0);
      expect(body.destroyed).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { body.destroy();vi.useRealTimers(); }
  });
});
