import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { NativeReferenceArchiveCoverageRoot } from "./native-reference-archive-segments";

/** Versioned metadata transport only. Original manifests, row bytes, canonical
 * digests and complete-generation membership keep their existing validators. */
export const NATIVE_ARCHIVE_ROOT_ENCODING = "native-archive-coverage-root.gzip-json.v1" as const;
export const NATIVE_ARCHIVE_ROOT_CODEC_LIMITS = Object.freeze({ decodedBytes: 2 * 1024 * 1024,
  gzipBytes: 512 * 1024, catalogSegments: 16 });
export type EncodedNativeArchiveRoot = {
  contract: typeof NATIVE_ARCHIVE_ROOT_ENCODING;
  decodedBytes: number;
  decodedSha256: string;
  gzipBase64: string;
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function need(value: unknown): asserts value {
  if (!value) throw new Error("Native historical archive refused: invalid compressed coverage root");
}
export function encodeNativeArchiveRoot(root: NativeReferenceArchiveCoverageRoot): EncodedNativeArchiveRoot {
  const bytes = Buffer.from(JSON.stringify(root));
  need(bytes.length > 0 && bytes.length <= NATIVE_ARCHIVE_ROOT_CODEC_LIMITS.decodedBytes);
  const compressed = gzipSync(bytes, { level: 6, maxOutputLength: NATIVE_ARCHIVE_ROOT_CODEC_LIMITS.gzipBytes });
  need(compressed.length > 0 && compressed.length <= NATIVE_ARCHIVE_ROOT_CODEC_LIMITS.gzipBytes);
  return { contract: NATIVE_ARCHIVE_ROOT_ENCODING, decodedBytes: bytes.length,
    decodedSha256: hash(bytes), gzipBase64: compressed.toString("base64") };
}

/** Only an explicitly versioned caller may accept this carrier. The encoded
 * file is independently SHA pinned; decoding has its OWN finite allocation
 * bound, canonical base64, exact byte length and digest. No row normalization. */
export function decodeNativeArchiveRoot(value: unknown, compact: boolean): NativeReferenceArchiveCoverageRoot {
  need(value && typeof value === "object" && !Array.isArray(value));
  const v = value as Record<string, unknown>;
  if (v.contract === undefined) return value as NativeReferenceArchiveCoverageRoot;
  need(compact && v.contract === NATIVE_ARCHIVE_ROOT_ENCODING &&
    Object.keys(v).sort().join(",") === "contract,decodedBytes,decodedSha256,gzipBase64" &&
    Number.isSafeInteger(v.decodedBytes) && Number(v.decodedBytes) > 0 &&
    Number(v.decodedBytes) <= NATIVE_ARCHIVE_ROOT_CODEC_LIMITS.decodedBytes &&
    typeof v.decodedSha256 === "string" && /^[a-f0-9]{64}$/.test(v.decodedSha256) &&
    typeof v.gzipBase64 === "string" && v.gzipBase64.length > 0 &&
    v.gzipBase64.length <= Math.ceil(NATIVE_ARCHIVE_ROOT_CODEC_LIMITS.gzipBytes / 3) * 4);
  const compressed = Buffer.from(v.gzipBase64, "base64");
  need(compressed.length <= NATIVE_ARCHIVE_ROOT_CODEC_LIMITS.gzipBytes && compressed.toString("base64") === v.gzipBase64);
  const bytes = gunzipSync(compressed, { maxOutputLength: Number(v.decodedBytes) });
  need(bytes.length === v.decodedBytes && hash(bytes) === v.decodedSha256);
  const root: unknown = JSON.parse(bytes.toString("utf8"));
  need(root && typeof root === "object" && !Array.isArray(root) && !(root as Record<string, unknown>).contract);
  return root as NativeReferenceArchiveCoverageRoot;
}
